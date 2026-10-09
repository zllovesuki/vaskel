import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  workspaceGridStyles,
  workspaceMainStyles,
} from "@vaskel/ui/components/control-styles";
import { resolveBrowserLanguage } from "@vaskel/ui/language";
import { NowPlayingBar, SharePip } from "./chrome";
import {
  arrivals,
  transcripts,
  unreadFrom,
  type Message,
  type PersonKey,
  type Room,
} from "./fixture";
import { Home } from "./home";
import { Stage, TextRoom } from "./room";
import type { Language } from "./strings";

/** Opening a room clears its unread mark, as the inbox does in the app. */
export function openRoom(unread: Set<Room>, room: Room) {
  if (!unread.has(room)) return unread;
  const next = new Set(unread);
  next.delete(room);
  return next;
}

/**
 * The preview speaks the visitor's language the way the app does before an
 * account preference exists. The prerendered page is English; hydration keeps
 * that frame and the browser's hints re-render it once.
 */
const browserLanguage = (): Language =>
  resolveBrowserLanguage(navigator.languages);
const subscribe = (notify: () => void) => {
  window.addEventListener("languagechange", notify);
  return () => window.removeEventListener("languagechange", notify);
};

/**
 * The product as the visitor would find it on a Friday night, operable in a
 * restrained way: rooms switch and the call follows the viewer. It opens on
 * the Lounge, where the call is.
 */
export function Preview() {
  const language = useSyncExternalStore<Language>(
    subscribe,
    browserLanguage,
    () => "en",
  );
  const [room, setRoom] = useState<Room>("lounge");
  const [unread, setUnread] = useState(
    () => new Set<Room>(["memes", "shirasu"]),
  );
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [general, setGeneral] = useState<Message[]>(transcripts.general);
  const [entering, setEntering] = useState(() => new Set<string>());
  const [typing, setTyping] = useState<PersonKey | null>(null);
  const timers = useRef<number[]>([]);

  // Two messages arrive in #general the first time the visitor opens it.
  useEffect(() => {
    if (
      room !== "general" ||
      timers.current.length > 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    timers.current = arrivals.flatMap((arrival) => [
      window.setTimeout(() => setTyping(arrival.author), arrival.after - 1600),
      window.setTimeout(() => {
        setTyping(null);
        setEntering((current) => new Set(current).add(arrival.at));
        setGeneral((current) => [...current, arrival]);
      }, arrival.after),
    ]);
  }, [room]);
  useEffect(
    () => () => timers.current.forEach((timer) => window.clearTimeout(timer)),
    [],
  );

  const go = (target: Room) => {
    setRoom(target);
    setUnread((current) => openRoom(current, target));
    setNavigationOpen(false);
  };
  const onStage = room === "lounge";
  const openNavigation = () => setNavigationOpen(true);

  return (
    <section
      className={`ws ${workspaceGridStyles} relative`}
      lang={language}
      data-navigation-open={navigationOpen ? "true" : undefined}
      aria-label="Preview of vaskel: Home on the left, the room on the right. Choose a room or a person to open it."
    >
      <Home
        language={language}
        room={room}
        unread={unread}
        go={go}
        closeNavigation={() => setNavigationOpen(false)}
        showDock={!onStage}
      />
      <div className={`ws-main ${workspaceMainStyles} relative`}>
        {!onStage && <NowPlayingBar language={language} go={go} />}
        {room === "general" && (
          <TextRoom
            language={language}
            room="general"
            messages={general}
            entering={entering}
            typing={typing}
            openNavigation={openNavigation}
          />
        )}
        {room === "memes" && (
          <TextRoom
            language={language}
            room="memes"
            messages={transcripts.memes}
            unreadFrom={unreadFrom.memes}
            openNavigation={openNavigation}
          />
        )}
        {room === "shirasu" && (
          <TextRoom
            language={language}
            room="shirasu"
            messages={transcripts.shirasu}
            unreadFrom={unreadFrom.shirasu}
            openNavigation={openNavigation}
          />
        )}
        {onStage && (
          <Stage
            language={language}
            openNavigation={openNavigation}
            leaveStage={() => go("general")}
          />
        )}
        {!onStage && <SharePip language={language} go={go} />}
      </div>
    </section>
  );
}
