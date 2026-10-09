import { Ellipsis, Mic, ScreenShare, VideoOff } from "lucide-react";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import {
  CallDock as CallDockView,
  CallStrip,
  CallSummary,
  LeaveButton,
  SharePip as SharePipView,
  Toggle,
} from "@vaskel/ui/components/call";
import { call, people } from "./fixture";
import { opens } from "./stand-ins";
import { t, type Language } from "./strings";
import { Terminal } from "./terminal";

type Nav = { language: Language; go: (room: "lounge") => void };

/** The call's line as the app writes it: the first names, how many more, and the time. */
function callStatus(language: Language) {
  const listed = call.participants
    .slice(0, 3)
    .map((key) =>
      key === "wren"
        ? t(language, "media.yourName", { name: people.wren.name })
        : people[key].name,
    );
  return `${listed.join(", ")} +${call.participants.length - listed.length} · ${call.duration}`;
}

/** The phone strip; the Home dock takes over from `sm`, as the app does. */
export function NowPlayingBar({ language, go }: Nav) {
  return (
    <CallStrip label={t(language, "media.nowPlaying")} className="sm:hidden">
      <CallSummary
        surface="stage"
        phase="active"
        render={opens(() => go("lounge"))}
        room={call.room}
        status={callStatus(language)}
      >
        <Toggle
          size="normal"
          state="on"
          label={t(language, "media.mute")}
          icon={<Mic className="size-5" aria-hidden="true" />}
          inert
        />
        <button
          type="button"
          className={buttonStyles({ variant: "stage", size: "small" })}
          onClick={() => go("lounge")}
        >
          {t(language, "media.openRoom")}
        </button>
        <LeaveButton size="normal" label={t(language, "media.leave")} inert />
      </CallSummary>
    </CallStrip>
  );
}

/** The shared screen while its stage is off screen, as the app keeps it in a corner. */
export function SharePip({ language, go }: Nav) {
  return (
    <SharePipView
      className="pipw absolute right-4 bottom-[158px] w-[280px] max-sm:bottom-[156px] max-sm:w-[150px]"
      render={(props) => (
        <button
          type="button"
          {...props}
          className={`${props.className} w-full text-left`}
          aria-label={t(language, "media.pictureInPicture")}
          onClick={() => go("lounge")}
        />
      )}
      media={
        <span className="share">
          <Terminal />
        </span>
      }
      room={call.room}
    />
  );
}

/** The call's home under Home's list while its stage is off screen. */
export function CallDock({ language, go }: Nav) {
  return (
    <CallDockView label={t(language, "media.nowPlaying")}>
      <CallSummary
        surface="light"
        phase="active"
        render={opens(() => go("lounge"))}
        room={call.room}
        status={`${t(language, "media.participantCount", {
          count: call.participants.length,
        })} · ${call.duration}`}
      >
        <LeaveButton size="normal" label={t(language, "media.leave")} inert />
      </CallSummary>
      <div className="flex items-center gap-1.5" inert>
        <Toggle
          surface="light"
          size="normal"
          state="on"
          label={t(language, "media.mute")}
          icon={<Mic className="size-5" aria-hidden="true" />}
        />
        <Toggle
          surface="light"
          size="normal"
          state="idle"
          label={t(language, "media.camera")}
          icon={<VideoOff className="size-5" aria-hidden="true" />}
        />
        <Toggle
          surface="light"
          size="normal"
          state="idle"
          label={t(language, "media.shareScreen")}
          icon={<ScreenShare className="size-5" aria-hidden="true" />}
        />
        <Toggle
          surface="light"
          size="normal"
          state="idle"
          label={t(language, "chat.moreActions")}
          icon={<Ellipsis className="size-4" aria-hidden="true" />}
        />
      </div>
    </CallDockView>
  );
}
