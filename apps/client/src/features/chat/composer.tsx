import { useI18n } from "@/client/features/i18n/use-i18n";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import {
  SendButton,
  composerBoxStyles,
  composerFrameStyles,
  composerInputStyles,
  composerToolbarStyles,
} from "@vaskel/ui/components/room";
import { Plus, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SendMessage } from "@vaskel/contracts/messaging";
import { MentionField, type MentionFieldHandle } from "./mention-field";
import { ComposerEmoji } from "./composer-emoji";
import { MESSAGE_ATTACHMENT_LIMIT } from "@vaskel/contracts/attachments";
import { FileSelection } from "@/client/features/files/file-selection";
import {
  dragCarriesFiles,
  filesFromDataTransfer,
} from "@/client/features/files/drop-files";
import type { DraftController } from "@/client/features/drafts/controller";
import { DraftQuote } from "@/client/features/drafts/quote";
import { quoteKind } from "@/client/features/chat/quote-selection";

export function Composer({
  controller,
  focusAfterSendRef,
  label,
  online,
  canSend = true,
  send,
  onTyping,
  status,
}: {
  controller: DraftController;
  focusAfterSendRef: RefObject<boolean>;
  label: string;
  online: boolean;
  canSend?: boolean;
  send: (body: SendMessage) => Promise<unknown>;
  onTyping?: () => void;
  status: ReactNode;
}) {
  const { t } = useI18n();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const { record, phase, preview } = state;
  const {
    target: { owner, channelId },
    text: draft,
    quote,
  } = record;
  const { body } = draft;
  const uploads = controller.uploads;
  const files = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  const limitsId = useId();
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const field = useRef<MentionFieldHandle>(null);
  const editable = online && phase === "authoring";
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    if (focusAfterSendRef.current) {
      focusAfterSendRef.current = false;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    }
    return () => {
      // The draft key resets editing state. Only an accepted send hands its
      // still-focused input to the next draft in this mounted conversation.
      const state = controller.getSnapshot();
      focusAfterSendRef.current =
        state.phase === "cleanup" &&
        state.outcome === "sent" &&
        document.activeElement === element;
    };
  }, [controller, focusAfterSendRef]);
  useEffect(() => {
    if (quote?.messageId) textarea.current?.focus();
  }, [quote?.messageId]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const setError = controller.setError;
  const setDraft = controller.setText;
  // Keyboard submission still lets the controller explain refused authoring work.
  const requestSend = () => {
    if (online) void controller.submit(canSend, send);
  };
  function chooseSendAction() {
    switch (state.phase) {
      case "authoring":
        return {
          label: t("chat.send"),
          title: t("chat.send"),
          retry: false,
          submit: requestSend,
          disabled:
            !online ||
            !canSend ||
            (!body.trim() && !files.length && !quote) ||
            uploads.readyAttachmentIds() === null,
        };
      case "retained":
        return {
          label: t("chat.retrySend"),
          title: t("chat.retrySend"),
          retry: true,
          submit: requestSend,
          disabled: !online,
        };
      case "submitting":
        return {
          label: t("chat.sending"),
          title: t("chat.retrySend"),
          retry: false,
          submit: undefined,
          disabled: true,
        };
      case "cleanup": {
        // Keep the completed action's label while only local cleanup remains.
        const retry = state.record.attempt !== null;
        const label = t(retry ? "chat.retrySend" : "chat.send");
        return {
          label,
          title: label,
          retry,
          submit: undefined,
          disabled: true,
        };
      }
    }
  }
  const { submit, ...sendAction } = chooseSendAction();
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit?.();
  }
  const attachDisabled =
    !editable || !canSend || files.length >= MESSAGE_ATTACHMENT_LIMIT;
  return (
    <div
      className={composerFrameStyles}
      data-composer
      onDragEnter={(event) => {
        if (attachDisabled || !dragCarriesFiles(event.dataTransfer.types))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (attachDisabled || !dragCarriesFiles(event.dataTransfer.types))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (!dragDepth.current) return;
        dragDepth.current -= 1;
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!dragCarriesFiles(event.dataTransfer.types)) return;
        // Refused drops are still consumed so the browser never opens the file.
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (attachDisabled) return;
        const dropped = filesFromDataTransfer(event.dataTransfer);
        if (!dropped.length) return;
        setError(uploads.select(dropped));
        textarea.current?.focus();
      }}
    >
      <form className={composerBoxStyles} onSubmit={onSubmit}>
        {dragging && !attachDisabled && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/80 text-ui font-medium text-ink">
            {t("chat.dropFiles")}
          </div>
        )}
        {quote && (
          <div className="flex items-start gap-2 border-b border-line px-3 pt-2 pb-1">
            <div className="min-w-0 flex-1">
              <DraftQuote
                reference={quote}
                preview={preview}
                online={online}
                kind={quoteKind(quote, owner, channelId)}
              />
            </div>
            {
              <button
                type="button"
                className={buttonStyles({ variant: "quiet", size: "icon" })}
                aria-label={t("chat.clearReply")}
                disabled={phase !== "authoring"}
                onClick={() => controller.setQuote(null)}
              >
                <X aria-hidden="true" />
              </button>
            }
          </div>
        )}
        <FileSelection
          previewAllowed={online}
          files={files}
          controller={uploads}
          disabled={!editable}
          uploadAllowed={canSend}
        />
        <MentionField
          ref={field}
          id="composer-input"
          textareaRef={textarea}
          draft={draft}
          onDraftChange={setDraft}
          owner={owner}
          channelId={channelId}
          online={online}
          wrapperClassName="min-w-0"
          className={composerInputStyles}
          aria-label={t("chat.messageTo", { label })}
          placeholder={t("chat.messageTo", { label })}
          onChange={(event) => {
            if (online && event.target.value) onTyping?.();
          }}
          disabled={!online}
          readOnly={phase !== "authoring"}
          rows={1}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit?.();
            }
          }}
          onPaste={(event) => {
            if (attachDisabled) return;
            const pasted = filesFromDataTransfer(event.clipboardData);
            if (!pasted.length) return;
            // Only a file clipboard is taken; text paste stays native.
            event.preventDefault();
            setError(uploads.select(pasted));
          }}
        />
        <div className={composerToolbarStyles}>
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            aria-label={t("chat.attachFiles")}
            aria-describedby={limitsId}
            disabled={!editable || !canSend}
            onChange={(event) => {
              if (canSend)
                setError(uploads.select(Array.from(event.target.files ?? [])));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className={buttonStyles({ variant: "muted", size: "icon" })}
            disabled={attachDisabled}
            onClick={() => input.current?.click()}
            title={t("chat.attachmentLimits")}
            aria-describedby={limitsId}
          >
            <Plus aria-hidden="true" />
            <span className="sr-only">{t("chat.attach")}</span>
          </button>
          <span id={limitsId} className="sr-only">
            {t("chat.attachmentLimits")}
          </span>

          {status}
          <ComposerEmoji
            key={editable ? "editable" : "readonly"}
            disabled={!editable}
            field={field}
            textarea={textarea}
            onTyping={onTyping}
          />
          <SendButton {...sendAction} />
        </div>
      </form>
    </div>
  );
}
