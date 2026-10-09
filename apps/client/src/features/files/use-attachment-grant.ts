import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
  AttachmentDescriptor,
  AttachmentGrant,
} from "@vaskel/contracts/attachments";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { privateKey } from "@/client/api/client";
import { api } from "@/client/api/contract";
import { useOptionalUser } from "@/client/features/auth/session-state";

const GRANT_MARGIN_MS = 5 * 60_000;

/** A grant this close to its end starts nothing new; the server keeps the final say. */
export const grantUsable = (grant: AttachmentGrant, now = Date.now()) =>
  grant.expiresAt - now > GRANT_MARGIN_MS;

export const attachmentGrantOptions = (
  userId: string,
  owner: OwnerScope,
  fileId: string,
) =>
  queryOptions({
    queryKey: [
      ...privateKey(userId),
      "file-grant",
      owner.kind,
      owner.id,
      fileId,
    ] as const,
    queryFn: ({ signal }) =>
      api.fileGrant({ params: { ...owner, fileId } }, { signal }),
    // A duration from dataUpdatedAt: a later mount or focus refetches a worn-out
    // grant. Nothing is scheduled; use-time freshness is `fresh()` below.
    staleTime: (query) =>
      Math.max(
        0,
        (query.state.data?.expiresAt ?? 0) -
          query.state.dataUpdatedAt -
          GRANT_MARGIN_MS,
      ),
    retry: false,
    // Rows re-mount under virtualization; a refused grant waits for Try again,
    // focus or reconnect instead of asking again on every scroll.
    retryOnMount: false,
  });

export interface AttachmentGrantState {
  grant: AttachmentGrant | undefined;
  url: string | undefined;
  /** When the held grant arrived; the viewer accepts anything fetched since it opened. */
  updatedAt: number;
  fetching: boolean;
  failed: boolean;
  retry: () => void;
  /** The cached URL while usable, otherwise a newly authorized one. */
  fresh: () => Promise<string>;
}

/**
 * One in-memory grant per account and file, shared by the inline preview, the
 * viewer, the download link and every range request. Opening, downloading and
 * retrying ask for a fresh URL; an already open video keeps the one it captured.
 */
export function useAttachmentGrant(
  owner: OwnerScope,
  file: AttachmentDescriptor,
  enabled: boolean,
): AttachmentGrantState {
  const user = useOptionalUser();
  const queryClient = useQueryClient();
  const userId = user?.userId ?? "";
  const { kind, id } = owner;
  const { fileId } = file;
  const query = useQuery({
    ...attachmentGrantOptions(userId, owner, fileId),
    enabled: enabled && user !== null,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const fresh = useCallback(async () => {
    const options = attachmentGrantOptions(userId, { kind, id }, fileId);
    const cached = queryClient.getQueryData(options.queryKey);
    if (cached && grantUsable(cached)) return cached.url;
    return (await queryClient.fetchQuery({ ...options, staleTime: 0 })).url;
  }, [queryClient, userId, kind, id, fileId]);
  return {
    grant: query.data,
    url: query.data?.url,
    updatedAt: query.dataUpdatedAt,
    fetching: query.isFetching,
    failed: query.isError,
    retry,
    fresh,
  };
}
