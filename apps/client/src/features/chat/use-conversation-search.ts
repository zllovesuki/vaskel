import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { api } from "@/client/api/contract";
import { messageSearchKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { resourceLocation } from "@/client/routes/resource-location";

export function useConversationSearch(
  owner: OwnerScope,
  channelId: string,
  interactive: boolean,
  jumpTo: (sequence: number) => void,
) {
  const user = useUser();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const results = useQuery({
    queryKey: messageSearchKey(user.userId, owner, channelId, search.q),
    enabled: interactive && Boolean(search.q),
    retry: false,
    queryFn: ({ signal }) =>
      api.searchMessages(
        { params: owner, body: { channelId, query: search.q ?? "" } },
        { signal },
      ),
  });
  // Opening a result collapses this search and brings the transcript back.
  // A different query shows its results; Show results reverses the collapse.
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  const collapsed = collapsedFor !== null && collapsedFor === search.q;
  const receded =
    interactive && Boolean(search.q) && search.at === undefined && !collapsed;

  // A link or a search result names one message. The jump runs once per
  // request; the parameter is then dropped so a refresh reopens the latest.
  const requested = useRef<number | null>(null);
  useEffect(() => {
    const at = search.at;
    if (at === undefined) {
      // The parameter is gone, so the same message can be opened again later.
      requested.current = null;
      return;
    }
    if (!interactive || requested.current === at) return;
    requested.current = at;
    jumpTo(at);
    void navigate({
      ...resourceLocation(owner, channelId),
      search: { ...(search.q ? { q: search.q } : {}) },
      replace: true,
    });
  }, [search.at, search.q, interactive, jumpTo, navigate, owner, channelId]);

  return {
    query: search.q,
    results,
    collapsed,
    receded,
    showResults: () => setCollapsedFor(null),
    close: () => {
      void navigate({ ...resourceLocation(owner, channelId), search: {} });
    },
    submit: (query: string) => {
      void navigate({
        ...resourceLocation(owner, channelId),
        search: { q: query || undefined },
      });
    },
    open: (sequence: number) => {
      setCollapsedFor(search.q ?? null);
      void navigate({
        ...resourceLocation(owner, channelId),
        search: { ...(search.q ? { q: search.q } : {}), at: sequence },
      });
    },
  };
}

export type ConversationSearch = ReturnType<typeof useConversationSearch>;
