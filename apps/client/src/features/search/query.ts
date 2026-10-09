import { infiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";
import {
  searchServers,
  type SearchFence,
  type SearchPage,
} from "@/client/api/search";
import { crossSearchKey } from "./invalidate";

export interface SearchFilters {
  q?: string | undefined;
  server?: string | undefined;
  channel?: string | undefined;
}

/** Why a phrase cannot be searched yet; `null` means it can. */
export function searchPhraseIssue(query: string): "short" | "long" | null {
  const length = Array.from(query.trim()).length;
  if (length < 3) return "short";
  return query.length > 1_024 || length > 256 ? "long" : null;
}

export const validSearchPhrase = (query: string) =>
  searchPhraseIssue(query) === null;

/** How long typing pauses before the page searches on its own. */
export const SEARCH_TYPING_PAUSE_MS = 1_000;

/** Only a definite denial retires earlier copies; missing/unavailable sources do not. */
export function reconcileSearchPages(
  data: InfiniteData<SearchPage, string | null>,
): InfiniteData<SearchPage, string | null> {
  const denied = new Set(data.pages.at(-1)?.deniedServerIds);
  if (!denied.size) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      hits: page.hits.filter((hit) => !denied.has(hit.serverId)),
    })),
  };
}

export function crossSearchOptions(
  accountId: string,
  filters: SearchFilters,
  epoch: number,
  fence: SearchFence,
) {
  const query = filters.q?.trim() ?? "";
  return infiniteQueryOptions({
    queryKey: [
      ...crossSearchKey(accountId),
      epoch,
      query,
      filters.server ?? null,
      filters.channel ?? null,
    ],
    initialPageParam: null as string | null,
    enabled: validSearchPhrase(filters.q ?? ""),
    retry: false,
    maxPages: 5,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    queryFn: ({ signal, pageParam }) =>
      searchServers(
        {
          query,
          ...(filters.server ? { serverId: filters.server } : {}),
          ...(filters.server && filters.channel
            ? { channelId: filters.channel }
            : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
        fence,
      ),
    getNextPageParam: (page: SearchPage) => page.nextCursor,
    structuralSharing: (_previous, next) =>
      reconcileSearchPages(next as InfiniteData<SearchPage, string | null>),
  });
}
