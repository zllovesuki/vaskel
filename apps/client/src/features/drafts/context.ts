import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { DraftManager } from "./manager";
import { draftTargetKey, type DraftTarget } from "./model";

export const DraftContext = createContext<DraftManager | null>(null);
export function useDraftManager() {
  const manager = useContext(DraftContext);
  if (!manager) throw new Error("Draft provider is required.");
  return manager;
}
export function useDraftRoom(target: DraftTarget, enabled: boolean) {
  const manager = useDraftManager();
  const key = draftTargetKey(target);
  const {
    owner: { kind, id },
    channelId,
    label,
  } = target;
  const stableTarget = useMemo(
    () => ({ owner: { kind, id }, channelId, label }),
    [kind, id, channelId, label],
  );
  const room = useSyncExternalStore(manager.subscribe, () =>
    manager.room(stableTarget),
  );
  useEffect(() => {
    if (enabled && !room) void manager.open(stableTarget).catch(() => {});
  }, [enabled, manager, stableTarget, room]);
  useEffect(
    () => () => {
      void manager.flush();
    },
    [manager, key],
  );
  return { manager, room };
}
