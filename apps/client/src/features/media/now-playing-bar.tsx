import { Link } from "@tanstack/react-router";
import { resourceLocation } from "@/client/routes/resource-location";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { CallStrip, CallSummary } from "@vaskel/ui/components/call";
import { useMedia, useMediaStage } from "./context";
import {
  CallErrorRow,
  EnableAudioButton,
  LeaveButton,
  PrimaryToggles,
  TransferPrompt,
} from "./controls";
import { useCallDuration, useParticipantNames } from "./call-hooks";
import { MediaPlayback } from "./playback";

/** Received audio plays exactly once, wherever the call is being shown. */
export function RemoteAudio() {
  const { t } = useI18n();
  const { state } = useMedia();
  return (
    <>
      {state.session?.remote
        .filter(
          (item) =>
            item.publication.source === "microphone" ||
            item.publication.source === "screen_audio",
        )
        .map((item) => (
          <MediaPlayback
            key={item.publication.id}
            stream={item.stream}
            audio
            label={t("media.callAudio")}
          />
        ))}
    </>
  );
}

/**
 * The phone strip: keeps controls available above the single column whenever
 * the call's stage is absent or hidden, including while mobile Home covers the
 * page. From `sm` up the Home dock (call-dock.tsx) takes over and the provider
 * leaves this unmounted.
 */
export function NowPlayingBar() {
  const { t, formatNumber } = useI18n();
  const { state } = useMedia();
  const stage = useMediaStage();
  const names = useParticipantNames(state.session?.snapshot ?? null);
  const duration = useCallDuration(state.joinedAt);
  if (
    (stage.visible && !state.transfer) ||
    (!state.room && !state.error && !state.transfer)
  )
    return null;
  const joined = state.phase === "active" || state.phase === "reconnecting";
  const participants = state.session?.snapshot.participants ?? [];
  const listed = participants
    .slice(0, 3)
    .map((p) => names.get(p.userId) ?? t("media.member"));
  const more = participants.length - listed.length;
  const caption =
    state.phase === "joining"
      ? t("media.joiningCall")
      : state.phase === "reconnecting"
        ? t("media.reconnecting")
        : state.phase === "error"
          ? t("media.callDisconnected")
          : [
              listed.join(", ") + (more > 0 ? ` +${formatNumber(more)}` : ""),
              duration,
            ]
              .filter(Boolean)
              .join(" · ");
  const room = state.room;
  return (
    <CallStrip label={t("media.nowPlaying")}>
      <TransferPrompt />
      {!stage.visible && <CallErrorRow />}
      {!stage.visible && room && (
        <CallSummary
          surface="stage"
          phase={state.phase}
          render={(props) => (
            <Link
              {...props}
              {...resourceLocation(room.owner, room.channelId)}
              search={{}}
            />
          )}
          room={state.label}
          status={caption}
        >
          {joined && <PrimaryToggles size="normal" only="microphone" />}
          <Link
            className={buttonStyles({
              variant: "stage",
              size: "small",
            })}
            {...resourceLocation(room.owner, room.channelId)}
            search={{}}
          >
            {t("media.openRoom")}
          </Link>
          <LeaveButton size="normal" />
          <EnableAudioButton />
        </CallSummary>
      )}
    </CallStrip>
  );
}
