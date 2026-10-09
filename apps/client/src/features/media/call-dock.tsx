import { Link } from "@tanstack/react-router";
import { Ellipsis, HeadphoneOff, Headphones } from "lucide-react";
import { resourceLocation } from "@/client/routes/resource-location";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  menuItemStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import {
  CallDock as CallDockView,
  CallSummary,
  toggleStyles,
} from "@vaskel/ui/components/call";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/client/ui/media-query";
import { Popover } from "@/client/ui/popover";
import { useMedia, useMediaStage } from "./context";
import { useCallDuration } from "./call-hooks";
import {
  CallErrorRow,
  DeviceGroups,
  EnableAudioButton,
  LeaveButton,
  PrimaryToggles,
  TransferPrompt,
} from "./controls";

/**
 * The call's home while its stage is not on screen: pinned under Home's list
 * from the `sm` breakpoint up, a light card in Home's own idiom. It never
 * covers the conversation, and its rows keep one height per phase so names,
 * elapsed time and connection changes never resize it. Phones keep the strip
 * above the workspace instead (see NowPlayingBar).
 */
export function CallDock() {
  const { t, text, formatNumber } = useI18n();
  const { controller, state } = useMedia();
  const { canUseNetwork } = useAccess();
  const stage = useMediaStage();
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const duration = useCallDuration(state.joinedAt);
  if (
    !wide ||
    (stage.visible && !state.transfer) ||
    (!state.room && !state.error && !state.transfer)
  )
    return null;
  const joined = state.phase === "active" || state.phase === "reconnecting";
  const participants = state.session?.snapshot.participants ?? [];
  const caption =
    state.phase === "joining"
      ? t("media.joiningCall")
      : state.phase === "reconnecting"
        ? t("media.reconnecting")
        : state.phase === "error"
          ? state.error
            ? text(state.error)
            : t("media.callDisconnected")
          : [
              t("media.participantCount", {
                count: formatNumber(participants.length),
              }),
              duration,
            ]
              .filter(Boolean)
              .join(" · ");
  const room = state.room;
  return (
    <CallDockView label={t("media.nowPlaying")}>
      <TransferPrompt surface="light" />
      {!stage.visible && room && (
        <>
          <CallSummary
            surface="light"
            phase={state.phase}
            render={(props) => (
              <Link
                {...props}
                {...resourceLocation(room.owner, room.channelId)}
                search={{}}
              />
            )}
            room={state.label}
            status={caption}
            failed={state.phase === "error"}
          >
            <LeaveButton size="normal" />
          </CallSummary>
          <div className="flex items-center gap-1.5">
            {joined ? (
              <>
                <PrimaryToggles surface="light" size="normal" />
                <Popover
                  label={
                    <>
                      <Ellipsis className="size-4" aria-hidden="true" />
                      <span className="sr-only">{t("chat.moreActions")}</span>
                    </>
                  }
                  buttonClass={toggleStyles({
                    surface: "light",
                    size: "normal",
                  })}
                  size="list"
                >
                  {(close) => (
                    <div className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        className={menuItemStyles}
                        aria-pressed={state.deafened}
                        onClick={() => {
                          controller.setDeafened(!state.deafened);
                          close();
                        }}
                      >
                        {state.deafened ? (
                          <Headphones
                            className="size-4 text-muted"
                            aria-hidden="true"
                          />
                        ) : (
                          <HeadphoneOff
                            className="size-4 text-muted"
                            aria-hidden="true"
                          />
                        )}
                        {state.deafened
                          ? t("media.undeafenSelf")
                          : t("media.deafenSelf")}
                      </button>
                      <DeviceGroups />
                    </div>
                  )}
                </Popover>
              </>
            ) : state.phase === "error" ? (
              <button
                className={textButtonStyles({ size: "small" })}
                disabled={!canUseNetwork}
                onClick={() => void controller.resume()}
              >
                {t("media.reconnect")}
              </button>
            ) : (
              <PrimaryToggles surface="light" size="normal" pending />
            )}
          </div>
          {joined && <CallErrorRow surface="light" />}
          <EnableAudioButton />
        </>
      )}
      {!stage.visible && !room && <CallErrorRow surface="light" />}
    </CallDockView>
  );
}
