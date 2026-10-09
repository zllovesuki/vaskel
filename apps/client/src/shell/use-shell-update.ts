import { useSyncExternalStore } from "react";
import { getShellUpdateAvailable, subscribeShellUpdate } from "./register";

export function useShellUpdate() {
  return useSyncExternalStore(
    subscribeShellUpdate,
    getShellUpdateAvailable,
    () => false,
  );
}
