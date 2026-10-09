import { useEffect, useRef } from "react";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  ParticipantList,
  PipToggle,
  ScreenChip,
  ScreenChips,
  Stage,
  StageBody,
  StageControls,
  StageHeader,
  StageScreen,
} from "@vaskel/ui/components/call";
import { RoomBlockNotice } from "@/client/features/blocking/room-block-notice";
import { useMedia, useMediaStage } from "./context";
import {
  CallErrorRow,
  DeafenToggle,
  DevicesMenu,
  EnableAudioButton,
  LeaveButton,
  PrimaryToggles,
} from "./controls";
import { useCallDuration, useParticipantNames } from "./call-hooks";
import { MediaPlayback } from "./playback";

import { CallParticipant } from "./call-participant";

/**
 * The call fills the room pane while the viewer is in its room. It mounts as
 * soon as a join starts, so the joining, failed and reconnecting phases show
 * here rather than in the background controls; the snapshot arrives once the
 * join is accepted.
 */
export function CallStage({
  title,
  context,
}: {
  title: string;
  /** The circle name, or the direct-message label. */
  context: string;
}) {
  const { t, formatNumber } = useI18n();
  const { controller, state } = useMedia();
  const { ref: stageRef } = useMediaStage();
  const { canUseNetwork } = useAccess();
  const session = state.session;
  const snapshot = session?.snapshot ?? null;
  const names = useParticipantNames(snapshot);
  const duration = useCallDuration(state.joinedAt);
  const participants = snapshot?.participants ?? [];
  const joined = state.phase === "active" || state.phase === "reconnecting";
  const screens = participants
    .filter(
      (p) =>
        p.id !== session?.participantId &&
        !state.hiddenUserIds.includes(p.userId),
    )
    .flatMap((p) =>
      p.publications
        .filter((pub) => pub.source === "screen_video")
        .map((pub) => ({
          ...pub,
          name: names.get(p.userId) ?? t("media.member"),
        })),
    );
  // A new sharer takes the surface when nothing was selected.
  const knownScreens = useRef<string>("");
  useEffect(() => {
    const ids = screens.map((screen) => screen.id).join(",");
    if (ids === knownScreens.current) return;
    knownScreens.current = ids;
    const first = screens[0];
    if (first && !session?.selectedScreen) controller.selectScreen(first.id);
  }, [screens, session?.selectedScreen, controller]);
  const selected = session?.remote.find(
    (item) => item.publication.id === session?.selectedScreen,
  );
  const localScreen = session?.local.find(
    (item) => item.source === "screen_video",
  );
  const cameras = participants.flatMap((participant) => {
    const own = participant.id === session?.participantId;
    const stream = own
      ? session?.local.find((item) => item.source === "camera")
      : session?.remote.find(
          (item) =>
            item.publication.participantId === participant.id &&
            item.publication.source === "camera",
        );
    return stream ? [{ participant, stream: stream.stream, own }] : [];
  });
  const count = participants.length;
  return (
    <Stage ref={stageRef}>
      <StageHeader
        phase={state.phase}
        title={title}
        context={context}
        status={
          state.phase === "joining"
            ? t("media.joining")
            : state.phase === "error"
              ? t("media.callDisconnected")
              : t("media.participantCount", { count: formatNumber(count) })
        }
        duration={duration || undefined}
      >
        {joined && (
          <PipToggle
            label={t("media.pictureInPicture")}
            aria-pressed={state.pictureInPicture}
            onClick={() =>
              controller.setPictureInPicture(!state.pictureInPicture)
            }
          />
        )}
      </StageHeader>
      {snapshot && <RoomBlockNotice snapshot={snapshot} active />}
      <StageBody>
        {(screens.length > 0 || localScreen) && (
          <ScreenChips
            label={t("media.screens")}
            note={localScreen ? t("media.youreSharing") : undefined}
          >
            {screens.map((screen) => (
              <ScreenChip
                key={screen.id}
                selected={session?.selectedScreen === screen.id}
                disabled={!canUseNetwork}
                onClick={() =>
                  controller.selectScreen(
                    session?.selectedScreen === screen.id ? null : screen.id,
                  )
                }
              >
                {screen.name}
              </ScreenChip>
            ))}
          </ScreenChips>
        )}
        {selected && (
          <StageScreen>
            <MediaPlayback
              stream={selected.stream}
              label={t("media.sharedScreen")}
            />
          </StageScreen>
        )}
        {localScreen && (
          <div className="mb-3 max-w-xs">
            <MediaPlayback
              stream={localScreen.stream}
              label={t("media.yourSharedScreen")}
              local
            />
          </div>
        )}
        {cameras.length > 0 && (
          <div className="mb-3 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {cameras.map(({ participant, stream, own }) => (
              <div key={participant.id} className="min-w-0">
                <MediaPlayback
                  stream={stream}
                  label={t("media.personCamera", {
                    name: names.get(participant.userId) ?? t("media.member"),
                  })}
                  local={own}
                />
                <p className="mt-1 truncate text-caption text-stage-muted">
                  {names.get(participant.userId) ?? t("media.member")}
                </p>
              </div>
            ))}
          </div>
        )}
        {state.phase === "joining" ? (
          <p className="text-caption text-stage-muted" role="status">
            {t("media.joiningCall")}
          </p>
        ) : joined ? (
          <ParticipantList label={t("media.atTheTable")}>
            {participants.map((participant) => (
              <CallParticipant
                key={participant.id}
                participant={participant}
                name={names.get(participant.userId) ?? t("media.member")}
              />
            ))}
          </ParticipantList>
        ) : null}
      </StageBody>
      <CallErrorRow />
      <StageControls>
        <PrimaryToggles pending={!joined} />
        {joined && <DeafenToggle />}
        {joined && <DevicesMenu />}
        <LeaveButton />
        <EnableAudioButton />
      </StageControls>
    </Stage>
  );
}
