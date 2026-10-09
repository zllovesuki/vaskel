import { useRef, useSyncExternalStore } from "react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { fieldStyles } from "@vaskel/ui/components/control-styles";
import { ComposerSkeleton } from "@/client/ui/workspace-skeleton";
import { Composer } from "@/client/features/chat/composer";
import { ComposerStatus } from "@/client/features/chat/composer-status";
import type { SendMessage } from "@vaskel/contracts/messaging";
import type { DraftTarget } from "./model";
import { useDraftRoom } from "./context";
import type { DraftController } from "./controller";

export function DraftComposer({
  target,
  online,
  canSend,
  send,
  onTyping,
  typing,
}: {
  target: DraftTarget;
  online: boolean;
  canSend: boolean;
  send: (body: SendMessage) => Promise<unknown>;
  onTyping: () => void;
  typing: string;
}) {
  const { manager, room } = useDraftRoom(target, online);
  const { t } = useI18n();
  const focusAfterSendRef = useRef(false);
  if (!room)
    return (
      <>
        <span role="status" className="sr-only">
          {t("drafts.loading")}
        </span>
        <ComposerSkeleton />
      </>
    );
  return (
    <>
      {room.drafts.length > 1 && (
        <div className="flex items-center gap-2 px-page-gutter pt-2">
          <label className="text-caption text-muted">
            {t("drafts.saved")}
            <select
              className={`${fieldStyles} ml-2 max-w-64`}
              value={room.active.getSnapshot().record.id}
              onChange={(event) => {
                const draft = room.drafts.find(
                  (draft) =>
                    draft.getSnapshot().record.id === event.target.value,
                );
                if (draft) manager.select(target, draft);
              }}
            >
              {room.drafts.map((draft, index) => (
                <DraftOption
                  key={draft.getSnapshot().record.id}
                  draft={draft}
                  index={index}
                />
              ))}
            </select>
          </label>
        </div>
      )}
      <Composer
        key={room.active.getSnapshot().record.id}
        controller={room.active}
        focusAfterSendRef={focusAfterSendRef}
        label={target.label}
        online={online}
        canSend={canSend}
        send={send}
        onTyping={onTyping}
        status={
          <ComposerStatus
            controller={room.active}
            online={online}
            canSend={canSend}
            typing={typing}
            unavailable={room.unavailable}
            elsewhere={room.elsewhere}
          />
        }
      />
    </>
  );
}
function DraftOption({
  draft,
  index,
}: {
  draft: DraftController;
  index: number;
}) {
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const { record } = state;
  const { t } = useI18n();
  function label() {
    switch (state.phase) {
      case "submitting":
        return t("chat.sending");
      case "retained":
        return t("chat.retrySend");
      case "cleanup":
        if (state.record.attempt) return t("chat.retrySend");
        break;
      case "authoring":
        break;
    }
    return (
      record.text.body.slice(0, 50) ||
      (record.quote
        ? t("chat.forwardMessage")
        : t("drafts.number", { number: String(index + 1) }))
    );
  }
  return <option value={record.id}>{label()}</option>;
}
