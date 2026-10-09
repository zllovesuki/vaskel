import { NavigationToggle } from "@vaskel/ui/components/home";
import { PhoneCall, Volume2 } from "lucide-react";
import { RoomHeader } from "@vaskel/ui/components/room";
import { CallStage } from "./call-stage";
import { CallSetupNotice } from "./call-setup-notice";
import { RoomBlockNotice } from "@/client/features/blocking/room-block-notice";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { type MediaRoomRef } from "@vaskel/contracts/media";
import { api } from "@/client/api/contract";

import { mediaErrorMessage, expectMedia, sameRoom } from "./protocol";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useQuery } from "@tanstack/react-query";

import { privateKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useAccountEvents } from "@/client/features/account-events/context";
import {
  buttonStyles,
  emptyStateStyles,
} from "@vaskel/ui/components/control-styles";
import { useMedia } from "./context";

import { CALL_SETUP_NOTICE_ID } from "./call-setup-notice";

export function JoinCallButton({
  room,
  label,
  canModerate = false,
}: {
  room: MediaRoomRef;
  label: string;
  canModerate?: boolean;
}) {
  const { t } = useI18n();

  const { controller, state } = useMedia();
  const { canUseNetwork } = useAccess();
  const joined =
    sameRoom(state.room, room) &&
    (state.phase === "active" || state.phase === "reconnecting");
  const joining = state.phase === "joining" && sameRoom(state.room, room);
  return (
    <button
      className={buttonStyles({
        variant: joined ? "quiet" : "primary",
        size: "small",
        shape: "round",
        className: joining ? "border-dashed" : "",
      })}
      disabled={
        !canUseNetwork ||
        state.configured !== true ||
        state.phase === "joining" ||
        joined
      }
      // Both surfaces that offer this button also carry the notice beside it.
      aria-describedby={
        state.configured === false ? CALL_SETUP_NOTICE_ID : undefined
      }
      onClick={() => void controller.join(room, label, canModerate)}
    >
      {joined ? (
        <span className="live-dot" aria-hidden="true" />
      ) : (
        <PhoneCall className="size-4" aria-hidden="true" />
      )}
      {joined
        ? t("media.inCall")
        : joining
          ? t("media.joining")
          : t("media.joinCall")}
    </button>
  );
}
export function MediaRoomPanel({
  resource,
  channelId,
  onNavigation,
}: {
  resource: ResourceSummary;
  channelId: string;
  onNavigation: () => void;
}) {
  const { t, text, formatNumber } = useI18n();

  const { state } = useMedia();
  const { canUseNetwork } = useAccess();
  const user = useUser();
  const inbox = useAccountEvents();
  const room = { owner: resource.owner, channelId };
  // The stage owns every phase of this room's call, joining and failed
  // included, so the background controls never need to stand in for it here.
  const here = sameRoom(state.room, room) && state.phase !== "idle";
  const title =
    resource.channels.find((channel) => channel.id === channelId)?.name ??
    t("media.call");
  const query = useQuery({
    queryKey: [
      ...privateKey(user.userId),
      "media-room",
      room.owner.kind,
      room.owner.id,
      room.channelId,
    ],
    enabled: canUseNetwork && state.configured === true && !here,
    queryFn: ({ signal }) =>
      api
        .mediaSnapshot({ body: { room } }, { signal: signal })
        .then((result) => expectMedia(result, "media_snapshot")),
    // Occupancy hints refetch this; the poll becomes a safety net.
    refetchInterval: canUseNetwork ? (inbox.connected ? 30_000 : 4_000) : false,
    retry: false,
  });
  const snapshot = here ? state.session?.snapshot : query.data?.snapshot;
  const count = snapshot?.participants.length ?? 0;
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={title}>
      <RoomHeader
        navigation={
          <NavigationToggle
            action="open"
            label={t("media.openConversations")}
            onClick={onNavigation}
          />
        }
        mark="media"
        title={title}
        subtitle={t("media.voiceChannelName", { name: resource.name })}
      />
      {here ? (
        <CallStage
          title={title}
          context={
            resource.owner.kind === "server"
              ? resource.name
              : t("chat.directConversation")
          }
        />
      ) : (
        <>
          {snapshot && <RoomBlockNotice snapshot={snapshot} />}
          <div className={emptyStateStyles}>
            <span
              className={`grid size-16 place-items-center rounded-full ${count > 0 ? "bg-live text-on-accent" : "bg-accent-soft text-accent"}`}
              aria-hidden="true"
            >
              <Volume2 className="size-7" />
            </span>
            <h2>{title}</h2>
            {state.configured === false ? (
              <CallSetupNotice className="max-w-[46ch] text-ui leading-relaxed text-muted" />
            ) : (
              <p className="text-ui text-muted">
                {count
                  ? t("media.peopleHere", {
                      count: formatNumber(count),
                      total: count,
                    })
                  : t("media.joinHint")}
              </p>
            )}
            <JoinCallButton
              room={room}
              label={title}
              canModerate={resource.role === "owner"}
            />
            {query.error && (
              <p className="text-ui text-error" role="alert">
                {text(mediaErrorMessage(query.error))}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
