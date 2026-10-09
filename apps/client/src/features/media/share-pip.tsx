import { Link } from "@tanstack/react-router";
import { SharePip, SharePipClose } from "@vaskel/ui/components/call";
import { resourceLocation } from "@/client/routes/resource-location";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useMedia, useMediaStage } from "./context";
import { MediaPlayback } from "./playback";

/**
 * A shared screen keeps a corner of the tab while the viewer is elsewhere.
 * It stays inside this tab: the account-media actor admits one endpoint per
 * account, so a separate window would be a transfer, not a mirror. It floats
 * above the composer's frame rather than in the very corner, so Send and the
 * last rows stay uncovered.
 */
export function SharePictureInPicture() {
  const { t } = useI18n();
  const { controller, state } = useMedia();
  const stage = useMediaStage();
  const joined = state.phase === "active" || state.phase === "reconnecting";
  const session = state.session;
  const selected = session?.remote.find(
    (item) => item.publication.id === session?.selectedScreen,
  );
  if (
    !state.room ||
    !joined ||
    stage.visible ||
    !selected ||
    !state.pictureInPicture
  )
    return null;
  const room = state.room;
  return (
    <SharePip
      className="fixed right-4 bottom-[calc(7rem+env(safe-area-inset-bottom,0px))] z-40 w-[min(280px,calc(100vw-32px))]"
      render={(props) => (
        <Link
          {...props}
          {...resourceLocation(room.owner, room.channelId)}
          search={{}}
          aria-label={t("media.pictureInPicture")}
        />
      )}
      media={
        <MediaPlayback
          stream={selected.stream}
          label={t("media.sharedScreen")}
        />
      }
      room={state.label}
      close={
        <SharePipClose
          label={t("media.hidePictureInPicture")}
          onClick={() => controller.setPictureInPicture(false)}
        />
      }
    />
  );
}
