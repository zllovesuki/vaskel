import { ChevronDown } from "lucide-react";
import { stripStyles } from "@vaskel/ui/components/control-styles";
import type { MediaRoomRef } from "@vaskel/contracts/media";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useMedia } from "./context";
import { CallStage } from "./call-stage";
import { CallSetupNotice } from "./call-setup-notice";
import { sameRoom } from "./protocol";

/** A DM keeps its transcript while the same call stage can be opened or folded. */
export function DirectCallPanel({
  room,
  title,
}: {
  room: MediaRoomRef;
  title: string;
}) {
  const { t, formatNumber } = useI18n();
  const { state } = useMedia();
  // Mounted from the first moment of a join, so joining and failed phases show
  // on the stage above the transcript rather than in the background controls.
  if (!sameRoom(state.room, room) || state.phase === "idle")
    // With no call to show, this slot explains why the header's Join is off.
    return state.configured === false ? (
      <CallSetupNotice className={`${stripStyles} [&>p]:max-w-[70ch]`} />
    ) : null;
  return (
    <details open className="group/direct-call shrink-0 border-b border-line">
      <summary className="flex min-h-target cursor-pointer list-none items-center gap-2 px-page-gutter py-1.5 text-caption font-semibold hover:bg-wash active:bg-press">
        <ChevronDown
          className="size-4 -rotate-90 transition-transform group-open/direct-call:rotate-0"
          aria-hidden="true"
        />
        {t("media.call")}
        <span className="font-normal text-muted">
          {state.phase === "joining"
            ? t("media.joining")
            : state.phase === "error"
              ? t("media.callDisconnected")
              : t("media.participantCount", {
                  count: formatNumber(
                    state.session?.snapshot.participants.length ?? 0,
                  ),
                })}
        </span>
      </summary>
      <div className="flex h-[min(42dvh,420px)] min-h-48 flex-col">
        <CallStage title={title} context={t("chat.directConversation")} />
      </div>
    </details>
  );
}
