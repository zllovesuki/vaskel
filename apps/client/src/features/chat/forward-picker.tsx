import { Working } from "@/client/ui/loading-skeleton";
import { ModalDialog } from "@/client/ui/dialog";
import { Failure } from "@/client/ui/failure";
import type { QuoteSelection } from "./quote-selection";

import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { api } from "@/client/api/contract";
import { privateKey } from "@/client/api/client";
import { useAccess } from "@/client/features/cache/access/context";
import { useUser } from "@/client/features/auth/session-state";
import { useI18n } from "@/client/features/i18n/use-i18n";

import { resourceLocation } from "@/client/routes/resource-location";
import { useDraftManager } from "@/client/features/drafts/context";
import {
  buttonRowStyles,
  buttonStyles,
  fieldStyles,
  labelStyles,
} from "@vaskel/ui/components/control-styles";

/** Forward only chooses a destination; the ordinary composer owns the new draft. */
export function ForwardPicker({
  quote,
  online,
  close,
}: {
  quote: QuoteSelection;
  online: boolean;
  close: () => void;
}) {
  const { t } = useI18n();
  const user = useUser();
  const access = useAccess();
  const drafts = useDraftManager();
  const navigate = useNavigate();
  const [resourceId, setResourceId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const directory = useInfiniteQuery({
    queryKey: [...privateKey(user.userId), "forward-directory"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.directory(
        { query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    enabled: online,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const resources =
    directory.data?.pages.flatMap((page) => page.resources) ?? [];
  const resource = resources.find(
    (item) => `${item.owner.kind}:${item.owner.id}` === resourceId,
  );
  const selectedOwner = resource?.owner;
  const capability = useQuery({
    queryKey: [
      ...privateKey(user.userId),
      "forward-capability",
      resourceId,
      selectedOwner ? access.ownerToken(selectedOwner) : null,
    ],
    queryFn: ({ signal }) =>
      api.resource({ params: selectedOwner! }, { signal }),
    enabled: online && Boolean(selectedOwner),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const channels =
    capability.data?.channels.filter((channel) => channel.kind === "text") ??
    [];
  // A DM is already a complete destination; only circles need a room choice.
  const channel =
    selectedOwner?.kind === "conversation"
      ? channels[0]
      : channels.find((item) => item.id === channelId);
  const writable =
    capability.data?.canSend === true && !capability.error && Boolean(channel);
  async function choose() {
    if (!resource || !channel || !writable || pending) return;
    setPending(true);
    try {
      const opened = await drafts.forward(
        {
          owner: resource.owner,
          channelId: channel.id,
          label:
            resource.owner.kind === "server"
              ? `#${channel.name} · ${resource.name}`
              : resource.name,
        },
        quote,
      );
      if (!opened) return;
      await navigate({
        ...resourceLocation(resource.owner, channel.id),
        search: {},
      });
      close();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }
  return (
    <ModalDialog
      title={t("chat.forwardMessage")}
      description={t("drafts.forwardHint")}
      width="wide"
      // A forward in flight owns the draft; dismissal waits for it to settle.
      close={() => {
        if (!pending) close();
      }}
    >
      <label className={labelStyles}>
        {t("chat.forwardDestination")}
        <select
          className={fieldStyles}
          value={resourceId}
          disabled={!online || pending}
          onChange={(event) => {
            setResourceId(event.target.value);
            setChannelId("");
          }}
        >
          <option value="">{t("chat.chooseDestination")}</option>
          {resources.map((item) => (
            <option
              key={`${item.owner.kind}:${item.owner.id}`}
              value={`${item.owner.kind}:${item.owner.id}`}
            >
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {resource?.owner.kind === "server" && (
        <label className={`${labelStyles} mt-3`}>
          {t("chat.forwardChannel")}
          <select
            className={fieldStyles}
            value={channelId}
            disabled={
              !online ||
              pending ||
              capability.data?.canSend !== true ||
              capability.isFetching
            }
            onChange={(event) => setChannelId(event.target.value)}
          >
            <option value="">{t("chat.chooseDestination")}</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {`#${channel.name}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {capability.isFetching && resource && (
        <Working className="mt-2">{t("chat.checkingAccess")}</Working>
      )}
      {capability.data?.canSend === false && (
        <p role="status" className="mt-2 text-caption text-muted">
          {t("chat.forwardDestinationUnavailable")}
        </p>
      )}
      {directory.isPending && online && (
        <Working className="mt-2">{t("chat.loading")}</Working>
      )}
      {!directory.isPending && !resources.length && (
        <p className="mt-2 text-caption text-muted">
          {t("chat.forwardNoDestinations")}
        </p>
      )}
      {directory.data?.pages.some((page) => page.partial) && (
        <p className="mt-2 text-caption text-muted">
          {t("chat.forwardPartial")}
        </p>
      )}
      <Failure className="mt-2" error={directory.error ?? capability.error} />
      <div className={`${buttonRowStyles} mt-2`}>
        <button
          className={buttonStyles({ variant: "quiet", size: "small" })}
          disabled={!online || directory.isFetching}
          onClick={() => {
            void directory.refetch();
            if (resource) void capability.refetch();
          }}
        >
          {t("chat.forwardRefresh")}
        </button>
        {directory.hasNextPage && (
          <button
            className={buttonStyles({ variant: "quiet", size: "small" })}
            disabled={!online || directory.isFetching}
            onClick={() => void directory.fetchNextPage()}
          >
            {t("chat.forwardLoadMore")}
          </button>
        )}
      </div>
      <Failure className="mt-2" error={error} />
      <div className={`${buttonRowStyles} mt-4 justify-end`}>
        <button
          className={buttonStyles({ variant: "quiet", size: "small" })}
          disabled={pending}
          onClick={close}
        >
          {t("chat.cancel")}
        </button>
        <button
          className={buttonStyles({ variant: "primary", size: "small" })}
          disabled={!online || !writable || capability.isFetching || pending}
          onClick={() => void choose()}
        >
          {t("chat.chooseForwardDestination")}
        </button>
      </div>
    </ModalDialog>
  );
}
