import { useSyncExternalStore } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { useDisplayNames } from "@/client/api/people";
import { useAccess } from "@/client/features/cache/access/context";
import { useMedia } from "@/client/features/media/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { resourceLocation } from "@/client/routes/resource-location";
import { personHue } from "@vaskel/ui/components/avatar";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { HomeSection, LiveCallCard } from "@vaskel/ui/components/home";
import {
  elapsedSince,
  liveRooms,
  type LiveRoom,
} from "@/client/features/workspace/live-rooms";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribeClock(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((fn) => fn()), 1_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const now = () => Math.floor(Date.now() / 1_000) * 1_000;

/** Live voice rooms across the viewer's circles, from the occupancy owners report. */
export function HappeningNow({
  resources,
  onNavigate,
}: {
  resources: ResourceSummary[];
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const rooms = liveRooms(resources);
  if (rooms.length === 0) return null;
  return (
    <HomeSection
      className="mb-4"
      aria-label={t("workspace.happeningNow")}
      label={t("workspace.happeningNow")}
    >
      <div className="flex flex-col gap-1.5">
        {rooms.map((room) => (
          <LiveRoomCard
            key={`${room.owner.kind}:${room.owner.id}:${room.channelId}`}
            room={room}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </HomeSection>
  );
}

function LiveRoomCard({
  room,
  onNavigate,
}: {
  room: LiveRoom;
  onNavigate: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const { canUseNetwork } = useAccess();
  const { controller, state } = useMedia();
  const navigate = useNavigate();
  const clock = useSyncExternalStore(subscribeClock, now, now);
  const ids = room.occupancy.participantIds;
  const { names } = useDisplayNames(ids, { includeViewer: true });
  const inThisCall =
    state.room?.owner.kind === room.owner.kind &&
    state.room.owner.id === room.owner.id &&
    state.room.channelId === room.channelId &&
    state.phase !== "idle";
  const sharer = room.occupancy.sharingUserIds[0];
  const duration = elapsedSince(room.occupancy.startedAt, clock);
  const location = resourceLocation(room.owner, room.channelId);
  return (
    <LiveCallCard
      render={(props) => (
        <Link {...props} {...location} search={{}} onClick={onNavigate} />
      )}
      people={ids.slice(0, 3).map((id) => ({
        name: names.get(id) ?? "?",
        hue: personHue(id),
      }))}
      more={ids.length > 3 ? formatNumber(ids.length - 3) : undefined}
      room={room.roomName}
      place={room.circleName || undefined}
      inCall={t("workspace.inTheCall", { count: formatNumber(ids.length) })}
      duration={duration || undefined}
      sharing={
        sharer
          ? t("workspace.isSharing", {
              name: names.get(sharer) ?? t("chat.member"),
            })
          : undefined
      }
      youAreIn={inThisCall ? t("workspace.youAreIn") : undefined}
      join={
        <button
          type="button"
          className={buttonStyles({
            variant: "primary",
            size: "small",
            className: "shrink-0",
          })}
          disabled={!canUseNetwork || state.configured === false}
          onClick={() => {
            onNavigate();
            void controller.join(
              { owner: room.owner, channelId: room.channelId },
              room.roomName,
              room.canModerate,
            );
            void navigate({ ...location, search: {} });
          }}
        >
          {t("workspace.join")}
        </button>
      }
    />
  );
}
