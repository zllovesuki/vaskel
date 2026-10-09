import { useCallback, useRef, useSyncExternalStore } from "react";
import type { MediaSnapshot } from "@vaskel/contracts/media";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { formatDuration } from "./presentation";
import { SpeakingMonitor } from "./speaking";

const subscribeClock = (listener: () => void) => {
  const timer = setInterval(listener, 1000);
  return () => clearInterval(timer);
};
const seconds = () => Math.floor(Date.now() / 1000);

/** Elapsed time since the call became active, ticking once a second. */
export function useCallDuration(joinedAt: number | null): string | null {
  const now = useSyncExternalStore(subscribeClock, seconds, seconds);
  return joinedAt === null ? null : formatDuration(now * 1000 - joinedAt);
}

/** Display names for everyone in the call, with the viewer marked as "you". */
export function useParticipantNames(snapshot: MediaSnapshot | null) {
  const { t } = useI18n();
  const user = useUser();
  const people = useDisplayNames(
    snapshot?.participants.map((p) => p.userId) ?? [],
  );
  const names = new Map(people.names);
  names.set(user.userId, t("media.yourName", { name: user.displayName }));
  return names;
}

/**
 * Whether the given stream is carrying speech right now. The monitor lives
 * inside the subscription so React creates and disposes it with the stream.
 */
export function useSpeaking(stream: MediaStream | null | undefined): boolean {
  const monitor = useRef<SpeakingMonitor | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!stream) return () => {};
      const next = new SpeakingMonitor(stream);
      monitor.current = next;
      const unsubscribe = next.subscribe(listener);
      return () => {
        unsubscribe();
        next.dispose();
        if (monitor.current === next) monitor.current = null;
      };
    },
    [stream],
  );
  return useSyncExternalStore(
    subscribe,
    () => monitor.current?.getSnapshot() ?? false,
    () => false,
  );
}
