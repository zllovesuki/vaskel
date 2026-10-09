import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useAccountEvents } from "@/client/features/account-events/context";
import { MediaController } from "./controller/index";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/client/ui/media-query";
import { MediaContext, MediaStageContext } from "./context";
import { NowPlayingBar, RemoteAudio } from "./now-playing-bar";
import { SharePictureInPicture } from "./share-pip";

export default function MediaProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const { subscribeCalls } = useAccountEvents();
  const [controller] = useState(
    () => new MediaController(user.userId, location.origin, canUseNetwork),
  );
  const [stageVisible, setStageVisible] = useState(false);
  // Phones get the strip above the single column; from `sm` up the Home dock
  // (mounted by the sidebar) carries the same state, so only one is mounted.
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const { session, pictureInPicture } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const stageRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    // A matching route alone does not supply controls: joins have no stage,
    // and mobile Home or a folded DM can hide a still-mounted stage.
    const disclosure = element.closest("details");
    let attached = true;
    const update = () => {
      if (attached)
        setStageVisible(
          element.getClientRects().length > 0 &&
            (disclosure === null || disclosure.open),
        );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // Closed details can retain their children's layout boxes, so geometry
    // and ResizeObserver alone cannot identify the folded DM stage.
    disclosure?.addEventListener("toggle", update);
    return () => {
      attached = false;
      observer.disconnect();
      disclosure?.removeEventListener("toggle", update);
      setStageVisible(false);
    };
  }, []);
  const stage = useMemo(
    () => ({ visible: stageVisible, ref: stageRef }),
    [stageVisible, stageRef],
  );
  useEffect(() => {
    controller.setNetworkAllowed(canUseNetwork);
  }, [controller, canUseNetwork]);
  useEffect(() => controller.attach(), [controller]);
  useEffect(
    () => subscribeCalls(controller.refreshRoom),
    [controller, subscribeCalls],
  );
  useEffect(() => {
    // Folding or leaving the stage stops cameras while an enabled PiP keeps
    // the explicitly selected screen and its audio in the same session.
    controller.showVideo(stageVisible, stageVisible || pictureInPicture);
  }, [
    controller,
    session?.participantId,
    stageVisible,
    pictureInPicture,
    canUseNetwork,
  ]);
  return (
    <MediaContext value={controller}>
      <MediaStageContext value={stage}>
        <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
          <RemoteAudio />
          {!wide && <NowPlayingBar />}
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          <SharePictureInPicture />
        </div>
      </MediaStageContext>
    </MediaContext>
  );
}
