import { roomSocketPath } from "@vaskel/contracts/api";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  type OwnerScope,
  type MessageEvent as CommittedEvent,
} from "@vaskel/contracts/messaging";
import type { TimelineProjection } from "@/client/features/cache/timeline-projection";
import { isDefinedError, safe } from "@orpc/client";
import { api } from "@/client/api/contract";

import {
  ServerEventSchema,
  type ServerEvent,
} from "@vaskel/contracts/messaging";
import { ApiError, apiFailure, messageSearchKey } from "@/client/api/client";
import { invalidateMessageSearch } from "@/client/features/chat/invalidate-message-search";
import {
  applyEvents,
  latestTimeline,
  observeEvents,
  observesMutation,
  sameStream,
  type Timeline,
} from "@/client/features/chat/reconcile";
import { refreshTimelineSnapshot } from "@/client/features/chat/timeline-navigation";

import { blockKey } from "@/client/api/blocks";
import { connectTicketSocket } from "@/client/api/ticket-socket";

export type ConnectionState =
  "connecting" | "connected" | "reconnecting" | "offline" | "denied";
export type TypingFrame = Extract<ServerEvent, { type: "typing" }>;
type CommittedFrame = Extract<ServerEvent, { type: "committed" }>;
const PING = '{"type":"ping"}';
const TYPING = '{"type":"typing"}';
export function connectTimeline({
  client,
  userId,
  key,
  owner,
  channelId,
  status,
  onDenied,
  onTyping,
  projection,
  subscribeContent,
  allowed = () => true,
}: {
  client: QueryClient;
  userId: string;
  key: QueryKey;
  owner: OwnerScope;
  channelId: string;
  status: (value: ConnectionState) => void;
  onDenied: (error: ApiError) => void;
  onTyping?: (frame: TypingFrame) => void;
  projection?: TimelineProjection | undefined;
  /** Account-event content hints, delivered after the owner's durable history was retired. */
  subscribeContent: (listener: (owner: OwnerScope) => void) => () => void;
  allowed?: () => boolean;
}) {
  const abort = new AbortController();
  const searchKey = messageSearchKey(userId, owner, channelId);
  function refreshSearch(events: CommittedEvent[], reset = false) {
    if (!events.length && !reset) return;
    const changed = new Set(
      events.filter(observesMutation).map((event) => event.message.id),
    );
    invalidateMessageSearch(client, searchKey, changed, reset);
  }
  let typingSentAt: number | undefined;
  let disposed = false;
  let denied = false;
  let reconciling: Promise<void> | undefined;
  let reconcileAgain = false;
  let replayHold: object | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  const active = () => !disposed && !denied && allowed();
  function rejectAccess() {
    if (!active()) return;
    denied = true;
    socket.dispose();
    status("denied");
  }
  function handleError(error: unknown) {
    const failure = apiFailure(error);
    if (
      active() &&
      failure &&
      ["forbidden", "unauthenticated", "not_found"].includes(failure.code)
    ) {
      rejectAccess();
      onDenied(failure);
    }
  }
  async function replay() {
    try {
      for (let page = 0; active() && !replayHold && page < 12; page++) {
        const state = client.getQueryData<Timeline>(key);
        if (!state) return;
        const lease = await projection?.capture();
        if (!active()) return;
        const result = await api
          .replay(
            { params: owner, body: { channelId, cursor: state.cursor } },
            { signal: abort.signal },
          )
          .catch((error) => {
            if (apiFailure(error)?.code === "reset_required") return null;
            throw error;
          });
        if (!active()) return;
        if (result === null) {
          refreshSearch([], true);
          await projection?.withhold();
          const replacementLease = await projection?.capture();
          if (!active()) return;
          const snapshot = await refreshTimelineSnapshot(
            async () =>
              api.snapshot(
                { params: owner, body: { channelId } },
                { signal: abort.signal },
              ),
            () => client.getQueryData<Timeline>(key),
          );
          if (active())
            client.setQueryData<Timeline>(key, (current) =>
              latestTimeline(snapshot, current),
            );
          if (active()) {
            const accepted = client.getQueryData<Timeline>(key);
            if (accepted)
              projection?.accepted(replacementLease ?? null, accepted, true);
          }
          continue;
        }
        const replayResult = result;
        // A mutation can concern an evicted row still present in offline history.
        // Purge before allowing any newer projection to be scheduled, even when
        // this replay page does not change the resident range.
        if (replayResult.events.some(observesMutation)) {
          await projection?.withhold();
          // withhold retires the producing lease. Only a subsequent request
          // may capture a fresh fence and make this history eligible again.
          if (projection) reconcileAgain = true;
        }
        if (!active()) return;
        client.setQueryData<Timeline>(key, (current) =>
          current
            ? applyEvents(current, replayResult.events, replayResult.cursor)
            : current,
        );
        const accepted = client.getQueryData<Timeline>(key);
        if (accepted) projection?.accepted(lease ?? null, accepted, false);
        refreshSearch(replayResult.events);
        if (!replayResult.hasMore) {
          if (accepted && sameStream(accepted.cursor, replayResult.cursor))
            restartFallback();
          if (socket.isReady()) status("connected");
          return;
        }
      }
    } catch (error) {
      handleError(error);
      if (active()) status(navigator.onLine ? "reconnecting" : "offline");
    }
  }
  function reconcile() {
    reconcileAgain = true;
    if (replayHold) return Promise.resolve();
    reconciling ??= (async () => {
      do {
        reconcileAgain = false;
        await replay();
      } while (active() && !replayHold && reconcileAgain);
    })().finally(() => {
      reconciling = undefined;
    });
    return reconciling;
  }
  /**
   * A committed frame may advance the contiguous cursor by itself only when it
   * names this stream, matches the resident generation, links its predecessor to
   * the local cursor and that cursor is at or above the owner's replay floor.
   */
  function contiguous(
    state: Timeline | undefined,
    frame: CommittedFrame,
  ): state is Timeline {
    return (
      !!state &&
      frame.cursor.owner.kind === owner.kind &&
      frame.cursor.owner.id === owner.id &&
      frame.cursor.channelId === channelId &&
      frame.cursor.generation === state.cursor.generation &&
      // Below the floor the retained events are gone; replay answers
      // reset_required even when the predecessor link looks contiguous.
      state.cursor.sequence >= frame.replayFloor &&
      frame.previous <= state.cursor.sequence &&
      state.cursor.sequence < frame.event.sequence
    );
  }
  /** Gaps, stale generations and cursors below the floor stay on replay. */
  function observeCommitted(frame: CommittedFrame) {
    if (observesMutation(frame.event)) void projection?.withhold();
    client.setQueryData<Timeline>(key, (current) =>
      current && current.cursor.generation === frame.cursor.generation
        ? observeEvents(current, [frame.event])
        : current,
    );
    refreshSearch([frame.event]);
    void reconcile();
  }
  function commit(frame: CommittedFrame) {
    if (!active()) return;
    if (replayHold || !contiguous(client.getQueryData<Timeline>(key), frame)) {
      observeCommitted(frame);
      return;
    }
    const lease = projection?.currentLease();
    // Retirement changes the projection lifetime synchronously and purges after
    // outstanding writes. The live timeline can still apply this frame now.
    if (observesMutation(frame.event)) void projection?.withhold();
    client.setQueryData<Timeline>(key, (current) =>
      current ? applyEvents(current, [frame.event], frame.cursor) : current,
    );
    const accepted = client.getQueryData<Timeline>(key);
    if (accepted) projection?.accepted(lease ?? null, accepted, false);
    refreshSearch([frame.event]);
    if (projection && observesMutation(frame.event)) void reconcile();
  }
  const socket = connectTicketSocket({
    path: roomSocketPath(owner),
    protocol: "vaskel-v1",
    ticket: async (signal) =>
      (
        await api.socketTicket(
          { params: owner, body: { channelId } },
          { signal },
        )
      ).ticket,
    active,
    status,
    onError: handleError,
    ping: PING,
    leaseMarginMs: 1_000,
    renew: async (connectionId, signal) => {
      const [error, result] = await safe(
        api.socketRenew(
          { params: owner, body: { channelId, connectionId } },
          { signal },
        ),
      );
      if (error) {
        if (isDefinedError(error) && error.code === "SOCKET_UNAVAILABLE")
          return null;
        throw error;
      }
      return result;
    },
    onResume: () => void reconcile(),
    onMessage: (event) => {
      let parsed;
      try {
        parsed = ServerEventSchema.safeParse(JSON.parse(event.data));
      } catch {
        socket.retry();
        return;
      }
      if (!parsed.success) {
        socket.retry();
        return;
      }
      const frame = parsed.data;
      socket.received(frame.type === "pong");
      if (frame.type === "dm_policy_changed") {
        void client.invalidateQueries({ queryKey: blockKey(userId) });
        return;
      }
      if (frame.type === "access_changed") {
        rejectAccess();
        onDenied(new ApiError("forbidden", undefined, "socket"));
        return;
      }
      if (frame.type === "lease_expired") {
        socket.reconnect();
        return;
      }
      if (frame.type === "ready") {
        if (!socket.acceptReady(frame.leaseExpiresAt, frame.connectionId))
          return;
        status("connected");
        void reconcile();
      }
      if (frame.type === "committed") commit(frame);
      if (frame.type === "typing") onTyping?.(frame);
      if (frame.type === "reconcile") void reconcile();
      if (frame.type === "read_updated" && frame.channelId === channelId)
        client.setQueryData<Timeline>(key, (current) =>
          current
            ? {
                ...current,
                readSequence: Math.max(current.readSequence, frame.sequence),
              }
            : current,
        );
    },
  });
  // Frames advance the cursor directly; a hint names content this stream may
  // have missed, and one arriving mid-replay still earns a trailing read.
  const removeHints = subscribeContent((hinted) => {
    if (hinted.kind === owner.kind && hinted.id === owner.id && active())
      void reconcile();
  });
  function restartFallback() {
    clearInterval(interval);
    if (!active()) return;
    // Only complete authoritative catch-up postpones final-event repair.
    // Keep retrying on this cadence when replay fails, pauses or stays partial.
    interval = setInterval(() => {
      if (active() && navigator.onLine) void reconcile();
    }, 60_000);
  }
  restartFallback();
  return {
    reconcile,
    /** Transient and never stored; the owner throttles the fan-out again. */
    sendTyping() {
      if (!socket.isReady()) return;
      const now = Date.now();
      if (typingSentAt !== undefined && now - typingSentAt < 3_000) return;
      typingSentAt = now;
      socket.send(TYPING);
    },
    /** One navigation owner; finish an in-flight replay before fetching Latest. */
    holdReplay() {
      const hold = {};
      replayHold = hold;
      return {
        settled: reconciling ?? Promise.resolve(),
        release() {
          if (replayHold !== hold) return;
          replayHold = null;
          if (active()) void reconcile();
        },
      };
    },
    dispose() {
      disposed = true;
      abort.abort();
      clearInterval(interval);
      removeHints();
      socket.dispose();
    },
  };
}
