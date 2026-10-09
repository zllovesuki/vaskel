import { useContext, useEffect } from "react";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { useUser } from "@/client/features/auth/session-state";
import { PresenceVisibleContext } from "@/client/features/presence/context";
import { holdViewing, viewingLockName } from "./message-sounds";

/**
 * Marks a conversation as being viewed while its pane is shown in a visible,
 * focused window, so no tab plays a message sound for it.
 */
export function useViewingLock(owner: OwnerScope, channelId: string) {
  const { userId } = useUser();
  // False while phone navigation covers the conversation pane.
  const shown = useContext(PresenceVisibleContext);
  const { kind, id } = owner;
  useEffect(() => {
    if (!shown) return;
    const name = viewingLockName(userId, { kind, id }, channelId);
    let release: (() => void) | undefined;
    const update = () => {
      const viewing =
        document.visibilityState === "visible" && document.hasFocus();
      if (viewing && !release) release = holdViewing(name);
      else if (!viewing && release) {
        release();
        release = undefined;
      }
    };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      release?.();
    };
  }, [shown, userId, kind, id, channelId]);
}
