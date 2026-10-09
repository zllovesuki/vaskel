import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  notificationsKey,
  notificationsOptions,
} from "@/client/api/notifications";
import { useUser } from "@/client/features/auth/session-state";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useAccess } from "@/client/features/cache/access/context";
import {
  playMessageSound,
  SoundPlayer,
  useMessageSounds,
} from "./message-sounds";

const UNLOCK_EVENTS = ["keydown", "pointerdown", "pointerup"] as const;

/**
 * Plays fresh arrivals for the signed-in account. Settings load when the account
 * opens and follow account events; playback never waits for them.
 */
export function MessageSoundCues() {
  const { userId } = useUser();
  const client = useQueryClient();
  const { canUseNetwork } = useAccess();
  const { subscribeActivity } = useAccountEvents();
  const [enabled] = useMessageSounds();
  useQuery({
    ...notificationsOptions(userId),
    enabled: canUseNetwork && enabled,
  });
  useEffect(() => {
    let current = true;
    const player = new SoundPlayer();
    // Browsers allow audio from these gestures: a key press, a mouse press, or a
    // finger or pen lifting.
    const unlock = () => void player.unlock();
    for (const type of UNLOCK_EVENTS)
      window.addEventListener(type, unlock, true);
    const remove = subscribeActivity((arrival) => {
      void playMessageSound(
        userId,
        arrival,
        client.getQueryData(notificationsKey(userId)),
        player,
        () => current,
      );
    });
    return () => {
      current = false;
      remove();
      for (const type of UNLOCK_EVENTS)
        window.removeEventListener(type, unlock, true);
      player.close();
    };
  }, [userId, client, subscribeActivity]);
  return null;
}
