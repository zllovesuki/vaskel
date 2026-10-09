import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { ComposerNotice } from "@vaskel/ui/components/room";
import type { DraftController } from "@/client/features/drafts/controller";

type Notice = {
  text: string;
  problem?: boolean;
  hint?: boolean;
  action?: "save" | "clear" | "dismiss";
};

// Recovery actions share the toolbar height and stay clear of Attach and Send.
const actionStyles = buttonStyles({ variant: "quiet", size: "inset" });

/** Status changes share the toolbar's middle, including on touch screens. */
export function ComposerStatus({
  controller,
  online,
  canSend,
  typing,
  unavailable,
  elsewhere,
}: {
  controller: DraftController;
  online: boolean;
  canSend: boolean;
  typing: string;
  unavailable: boolean;
  elsewhere: boolean;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const { t, text } = useI18n();
  // First match wins. Select copy and action together so typing or a hint
  // cannot hide a failure or leave a button belonging to a different notice.
  function chooseNotice(): Notice {
    if (state.saveFailed)
      return {
        text: t(
          state.phase === "cleanup" || !controller.hasWork()
            ? "drafts.clearFailed"
            : "drafts.notSaved",
        ),
        problem: true,
        action: "save",
      };
    if (state.error)
      return {
        text: text(state.error),
        problem: true,
        action:
          state.phase === "retained" || state.phase === "submitting"
            ? "clear"
            : "dismiss",
      };
    if (unavailable) return { text: t("drafts.restoreFailed"), problem: true };
    if (!online) return { text: t("chat.reconnectToSend") };
    if (!canSend) return { text: t("chat.directMessagesBlocked") };
    if (state.phase === "submitting") return { text: t("chat.sending") };
    if (typing) return { text: typing };
    if (elsewhere) return { text: t("drafts.otherTab") };
    // Enter inserts a newline here, unlike most chat apps, so the send shortcut
    // stays as the slot's quiet default on fine pointers; touch hides it.
    return { text: t("chat.composerShortcut"), hint: true };
  }
  const notice = chooseNotice();
  return (
    <ComposerNotice
      text={notice.text}
      problem={notice.problem ?? false}
      hint={notice.hint ?? false}
    >
      {notice.action === "save" ? (
        <button
          type="button"
          className={actionStyles}
          disabled={state.saving || state.phase === "submitting"}
          onClick={() => void controller.retrySave()}
        >
          {t("drafts.retrySave")}
        </button>
      ) : notice.action === "clear" ? (
        <button
          type="button"
          className={actionStyles}
          title={t("drafts.discardUncertain")}
          aria-description={t("drafts.discardUncertain")}
          disabled={state.phase === "submitting"}
          onClick={() => void controller.discard()}
        >
          {t("drafts.discard")}
        </button>
      ) : notice.action === "dismiss" ? (
        <button
          type="button"
          className={actionStyles}
          aria-label={t("common.close")}
          onClick={() => controller.setError(null)}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </ComposerNotice>
  );
}
