import {
  createContext,
  useContext,
  useSyncExternalStore,
  type RefCallback,
} from "react";
import type { MediaController } from "./controller/index";

export const MediaContext = createContext<MediaController | null>(null);
/** The mounted stage reports whether its controls are actually visible. */
export const MediaStageContext = createContext<{
  visible: boolean;
  ref: RefCallback<HTMLDivElement>;
} | null>(null);
export function useMediaStage() {
  const stage = useContext(MediaStageContext);
  if (!stage) throw new Error("Call surfaces require a media provider.");
  return stage;
}
export function useMediaController() {
  const controller = useContext(MediaContext);
  if (!controller)
    throw new Error("Calls require an authenticated media provider.");
  return controller;
}
export function useMedia() {
  const controller = useMediaController();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { controller, state };
}
