import { apiFailure } from "@/client/api/errors";
import { type OwnerScope } from "@vaskel/contracts/messaging";
import { type TimelineCommand } from "@/client/features/chat/reconcile";
import type {
  TimelineDestination,
  TimelineNavigation,
} from "@/client/features/chat/timeline-navigation";
import { type ProjectionLease } from "@/client/features/cache/timeline-projection";
import { api } from "@/client/api/contract";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { timelineKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import {
  connectTimeline,
  type ConnectionState,
} from "@/client/features/chat/connection";
import {
  followTimeline,
  latestTimeline,
  marksRead,
  observeReceipt,
  type Timeline,
} from "@/client/features/chat/reconcile";
import {
  navigateAroundTimeline,
  navigateTimeline,
  refreshTimelineSnapshot,
} from "@/client/features/chat/timeline-navigation";
import { syncTimelineActivity } from "@/client/features/activity/reconcile";
import { useAccess } from "@/client/features/cache/access/context";
import { useAccountEvents } from "@/client/features/account-events/context";
import { TimelineProjection } from "@/client/features/cache/timeline-projection";
import type { SnapshotLabels } from "@/client/features/cache/model";
import { useDisplayNames } from "@/client/api/people";
import { handleTimelineMutationFailure } from "@/client/features/chat/mutation-failure";
import { timelinePresentation } from "./timeline-presentation";

export const useOnline = () => useAccess().canUseNetwork;
/**
 * A message the owner cannot find. Reacting to a row that was deleted, or
 * opening a link to a position this channel never had, both answer `not_found`
 * and must stay local: neither says the reader lost access to the channel.
 */
const missingMessage = (error: unknown) =>
  apiFailure(error) && apiFailure(error)?.code === "not_found";
export function useTimeline(
  owner: OwnerScope,
  channelId: string,
  labels: Omit<SnapshotLabels, "authors">,
) {
  const user = useUser();
  const client = useQueryClient();
  const {
    canUseNetwork,
    accountFence,
    ownerDenied,
    deniedOwners,
    invalidatedOwners,
    ownerReady,
    ownerToken,
    invalidateOwnerView,
  } = useAccess();
  const { subscribeContent } = useAccountEvents();
  const scope = useMemo(
    () => ({ kind: owner.kind, id: owner.id }),
    [owner.kind, owner.id],
  );
  const historyHidden = invalidatedOwners.includes(`${scope.kind}:${scope.id}`);
  const requestToken = ownerToken(scope);
  const network = useRef(canUseNetwork && !historyHidden);
  const savedLabels = useRef<SnapshotLabels>({ ...labels, authors: [] });
  useEffect(() => {
    network.current = canUseNetwork && !historyHidden;
  });
  const projection = useRef<TimelineProjection | null>(null);
  const pendingSnapshot = useRef<{
    state: Timeline;
    lease: ProjectionLease | null;
    token: string;
  } | null>(null);
  const ensureProjection = useCallback(() => {
    projection.current ??= accountFence
      ? new TimelineProjection(accountFence, scope, () => savedLabels.current)
      : null;
    return projection.current;
  }, [accountFence, scope]);
  useEffect(() => {
    const instance = ensureProjection();
    return () => {
      instance?.dispose();
      if (projection.current === instance) projection.current = null;
    };
  }, [ensureProjection]);
  const key = useMemo(
    () => timelineKey(user.userId, scope, channelId),
    [user.userId, scope, channelId],
  );
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [denied, setDenied] = useState<string | null>(null);
  // Transient presence for this channel only: who is typing, until when.
  const [typing, setTyping] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  useEffect(() => {
    if (typing.size === 0) return;
    const expire = () => {
      const now = Date.now();
      setTyping((current) => {
        const next = new Map(
          [...current].filter(([, expiresAt]) => expiresAt > now),
        );
        return next.size === current.size ? current : next;
      });
    };
    // One timer for the whole channel; it re-arms on the next soonest expiry.
    const timer = setTimeout(
      expire,
      Math.max(0, Math.min(...typing.values()) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [typing]);
  // Capture once from an authorized opening snapshot, before private read
  // updates can advance Query's mutable readSequence. Reconnects retain it.
  const [entryReadSequence, setEntryReadSequence] = useState<number | null>(
    null,
  );
  const controller = useRef<ReturnType<typeof connectTimeline> | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const visibleSequence = useRef<number | undefined>(undefined);
  const lifecycle = useRef({ active: true });
  useEffect(() => {
    const generation = lifecycle.current.active
      ? lifecycle.current
      : { active: true };
    lifecycle.current = generation;
    return () => {
      generation.active = false;
      historyRequest.current?.abort();
    };
  }, []);
  const query = useQuery({
    queryKey: key,
    enabled: canUseNetwork && !denied,
    refetchOnReconnect: false,
    refetchOnMount: "always",
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }): Promise<Timeline> => {
      const generation = lifecycle.current;
      const exporter = ensureProjection();
      const lease = await exporter?.capture();
      if (signal.aborted) throw signal.reason;
      const token = ownerToken(scope);
      const snapshot = await refreshTimelineSnapshot(
        async () =>
          await api.snapshot(
            { params: scope, body: { channelId } },
            { signal: signal },
          ),
        () => client.getQueryData<Timeline>(key),
      );
      const current = client.getQueryData<Timeline>(key);
      const state = latestTimeline(snapshot, current);
      if (generation.active)
        pendingSnapshot.current = { state, lease: lease ?? null, token };
      return state;
    },
  });
  const refetch = query.refetch;
  useEffect(() => {
    // Another retirement cancels the pending query even while history stays hidden.
    if (historyHidden && canUseNetwork) void refetch();
  }, [historyHidden, canUseNetwork, refetch, requestToken]);
  useEffect(() => {
    let active = true;
    const recheck = async () => {
      if (document.visibilityState !== "visible") return;
      const current = projection.current;
      if (current && !(await current.recheck()) && active)
        invalidateOwnerView(scope);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      active = false;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [scope, invalidateOwnerView]);
  const ids = [
    ...(query.data?.messages.flatMap((message) => [
      message.authorId,
      ...(message.quote ? [message.quote.authorId] : []),
      // A mention names an account the reader may have no message from.
      ...message.mentions,
    ]) ?? []),
    // A typist need not have a resident message; the indicator still names them.
    ...typing.keys(),
  ];
  const { names } = useDisplayNames(ids, {
    includeViewer: true,
    enabled: !denied && !query.error,
  });
  useEffect(() => {
    const messages = query.data?.messages ?? [];
    const authors = [...names]
      .filter(([id]) =>
        messages.some(
          (item) => item.authorId === id || item.quote?.authorId === id,
        ),
      )
      .map(([id, label]) => ({ id, label }));
    if (!authors.some((author) => author.id === user.userId))
      authors.push({ id: user.userId, label: user.displayName });
    savedLabels.current = {
      owner: labels.owner,
      channel: labels.channel,
      authors,
    };
  }, [
    names,
    query.data?.messages,
    user.userId,
    user.displayName,
    labels.owner,
    labels.channel,
  ]);
  useEffect(() => {
    const pending = pendingSnapshot.current;
    if (
      pending &&
      query.data &&
      !query.isFetching &&
      !query.error &&
      pending.state.cursor.generation === query.data.cursor.generation &&
      pending.state.cursor.sequence <= query.data.cursor.sequence &&
      pending.token === ownerToken(scope)
    ) {
      // Replay may advance Query before this effect. The opening read position
      // still belongs to the original snapshot; capturing it grants no access.
      setEntryReadSequence((current) => current ?? pending.state.readSequence);
    }
    if (
      pending &&
      query.data &&
      !query.isFetching &&
      !query.error &&
      pending.state.cursor.generation === query.data.cursor.generation &&
      pending.state.cursor.sequence === query.data.cursor.sequence
    ) {
      pendingSnapshot.current = null;
      if (!ownerReady(scope, pending.token)) return;
      projection.current?.accepted(pending.lease, query.data, true);
    }
  }, [
    query.data,
    query.dataUpdatedAt,
    query.isFetching,
    query.error,
    ownerReady,
    ownerToken,
    scope,
  ]);
  useEffect(() => {
    if (query.data && !denied && !query.error)
      syncTimelineActivity(client, user.userId, scope, channelId, query.data);
  }, [client, user.userId, scope, channelId, query.data, denied, query.error]);
  useEffect(() => {
    if (
      apiFailure(query.error) &&
      ["forbidden", "not_found", "unauthenticated"].includes(
        apiFailure(query.error)?.code ?? "",
      )
    )
      void ownerDenied(scope, apiFailure(query.error)!);
  }, [scope, query.error, ownerDenied]);
  const ready = query.isSuccess && !query.isFetching;
  useEffect(() => {
    if (!ready || denied || !canUseNetwork || historyHidden) return;
    const connectionController = connectTimeline({
      client,
      userId: user.userId,
      key,
      owner: scope,
      channelId,
      status: setConnection,
      projection: projection.current ?? undefined,
      allowed: () => network.current,
      subscribeContent,
      onTyping: (frame) => {
        if (frame.channelId !== channelId || frame.userId === user.userId)
          return;
        setTyping((current) => {
          const next = new Map(current);
          next.set(frame.userId, frame.expiresAt);
          return next;
        });
      },
      onDenied: (error) => {
        void ownerDenied(scope, error);
        setDenied(error.code);
      },
    });
    controller.current = connectionController;
    return () => {
      connectionController.dispose();
      controller.current = null;
    };
  }, [
    client,
    key,
    scope,
    channelId,
    ready,
    denied,
    user.userId,
    canUseNetwork,
    historyHidden,
    ownerDenied,
    subscribeContent,
  ]);
  function handleMutationError(error: unknown) {
    if (!lifecycle.current.active) return;
    handleTimelineMutationFailure(error, {
      client,
      userId: user.userId,
      deny: (denial) => {
        void ownerDenied(scope, denial);
        setDenied(denial.code);
        controller.current?.dispose();
      },
      reconcile: () => {
        void controller.current?.reconcile();
      },
    });
  }

  const command = useMutation({
    onError: handleMutationError,
    mutationFn: async ({ operation, body }: TimelineCommand) => {
      if (!network.current)
        throw new UiMessageError(message("chat.offlineSend"));
      const generation = lifecycle.current;
      if (operation !== "send") await projection.current?.withhold();
      if (!network.current || !generation.active)
        throw new UiMessageError(message("chat.offlineMutation"));
      let result;
      try {
        switch (operation) {
          case "send":
            result = await api.send({ params: scope, body });
            break;
          case "edit":
            result = await api.edit({ params: scope, body });
            break;
          case "delete":
            result = await api.deleteMessage({ params: scope, body });
            break;
          case "react":
            result = await api.react({ params: scope, body });
            break;
          case "remove-attachment":
            result = await api.removeAttachment({ params: scope, body });
            break;
        }
      } catch (failure) {
        // A row deleted while the palette was open is a missing message, not an
        // access change. Replay tombstones it; the local intent ends here.
        if (operation === "react" && missingMessage(failure)) {
          void controller.current?.reconcile();
          throw new UiMessageError(message("chat.messageUnavailable"));
        }
        throw failure;
      }
      if (generation.active) {
        client.setQueryData<Timeline>(key, (state) =>
          state ? observeReceipt(state, operation, result.receipt) : state,
        );
        // Acceptance completes the command; this connection owns replay repair.
        void controller.current?.reconcile();
      }
      return result;
    },
  });
  const history = useMutation({
    onError: handleMutationError,
    mutationFn: async (
      intent: TimelineNavigation,
    ): Promise<TimelineDestination | undefined> => {
      const generation = lifecycle.current;
      if (!network.current) return;
      historyRequest.current?.abort();
      const abort = new AbortController();
      historyRequest.current = abort;
      const token = ownerToken(scope);
      const current = () =>
        generation.active &&
        network.current &&
        !abort.signal.aborted &&
        token === ownerToken(scope);
      const hold =
        intent === "latest" ? controller.current?.holdReplay() : undefined;
      const window = {
        read: () => client.getQueryData<Timeline>(key),
        write: (state: Timeline) => client.setQueryData<Timeline>(key, state),
        current,
        visibleSequence: () => visibleSequence.current,
      };
      try {
        await hold?.settled;
        if (!current()) return;
        const exporter = ensureProjection();
        const lease = await exporter?.capture();
        if (!current()) return;
        const accepted =
          intent === "older" || intent === "latest"
            ? await navigateTimeline({
                ...window,
                direction: intent,
                fetchSnapshot: async (before) =>
                  await api.snapshot(
                    {
                      params: scope,
                      body: {
                        channelId,
                        ...(before !== undefined ? { before } : {}),
                      },
                    },
                    { signal: abort.signal },
                  ),
              })
            : await navigateAroundTimeline({
                ...window,
                target: intent === "newer" ? "newer" : intent.at,
                fetchAround: async (sequence) =>
                  await api.around(
                    { params: scope, body: { channelId, sequence } },
                    { signal: abort.signal },
                  ),
              });
        if (accepted && current()) {
          const state = client.getQueryData<Timeline>(key);
          if (!state) return;
          exporter?.accepted(lease ?? null, state, intent === "latest");
          // Alignment belongs to accepted navigation, not changes in reading mode.
          if (intent === "latest")
            return { kind: "latest", revision: state.windowVersion };
          if (typeof intent !== "string")
            return {
              kind: "message",
              sequence: intent.at,
              revision: state.windowVersion,
            };
        }
      } catch (error) {
        if (!current()) return;
        // A stale `?at=` link names a position this channel never had, or one
        // whose row is gone. The window the reader is on stays exactly as it is.
        if (intent !== "older" && intent !== "latest" && missingMessage(error))
          throw new UiMessageError(message("chat.jumpUnavailable"));
        throw error;
      } finally {
        hold?.release();
        if (historyRequest.current === abort) historyRequest.current = null;
      }
    },
  });
  const navigateHistory = history.mutate;
  const jumpTo = useCallback(
    (sequence: number) => navigateHistory({ at: sequence }),
    [navigateHistory],
  );
  const positionChanged = useCallback(
    (atBottom: boolean, sequence?: number) => {
      visibleSequence.current = sequence;
      // Initial row measurement may scroll the old latest window while an
      // explicit history jump is still loading. It must not resume following.
      if (historyRequest.current) return;
      client.setQueryData<Timeline>(key, (state) =>
        state ? followTimeline(state, atBottom) : state,
      );
    },
    [client, key],
  );
  const read = useMutation({
    onError: handleMutationError,
    mutationFn: async (sequence: number) => {
      const generation = lifecycle.current;
      const state = client.getQueryData<Timeline>(key);
      if (
        entryReadSequence === null ||
        historyRequest.current !== null ||
        !network.current ||
        !state ||
        !marksRead(state, sequence)
      )
        return;
      const result = await api.updateRead({
        params: scope,
        body: {
          channelId,
          sequence,
        },
      });
      if (generation.active)
        client.setQueryData<Timeline>(key, (current) =>
          current
            ? {
                ...current,
                readSequence: Math.max(current.readSequence, result.sequence),
              }
            : current,
        );
    },
  });
  const accessError =
    (deniedOwners.includes(`${scope.kind}:${scope.id}`) ? "forbidden" : null) ??
    denied ??
    (apiFailure(query.error) &&
    ["forbidden", "not_found", "unauthenticated"].includes(
      apiFailure(query.error)?.code ?? "",
    )
      ? apiFailure(query.error)!.code
      : null);
  return {
    view: timelinePresentation(
      query,
      { canUseNetwork, denial: accessError, historyHidden },
      query.refetch,
    ),
    key,
    connection,
    names,
    typing: [...typing.keys()],
    sendTyping: () => controller.current?.sendTyping(),
    entryReadSequence,
    command,
    history,
    destination:
      history.data?.revision === query.data?.windowVersion
        ? history.data
        : undefined,
    /** Opens the window around one message; “Load newer” pages back to latest. */
    jumpTo,
    positionChanged,
    reconcile: () => void controller.current?.reconcile(),
    markRead: read.mutate,
  };
}
