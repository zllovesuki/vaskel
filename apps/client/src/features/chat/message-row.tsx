import { ConfirmRow } from "@/client/ui/confirm-row";
import { useOptionalUser } from "@/client/features/auth/session-state";
import { type UiMessage } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { personHue } from "@vaskel/ui/components/avatar";
import {
  buttonRowStyles,
  buttonStyles,
  fieldStyles,
} from "@vaskel/ui/components/control-styles";
import {
  MessageRow as MessageRowView,
  messageBodyStyles,
} from "@vaskel/ui/components/room";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Message, OwnerScope } from "@vaskel/contracts/messaging";
import { errorMessage } from "@/client/api/client";
import { MessageFiles } from "@/client/features/files/message-files";
import { MessageContext } from "@/client/features/chat/message-context";
import { MessageCommands } from "@/client/features/chat/message-commands";
import { BodyView } from "@/client/features/chat/body-view";
import { MentionField } from "@/client/features/chat/mention-field";
import { decodeMentionDraft } from "@/client/features/chat/mentions";
import {
  ReactionPills,
  type ReactionEmoji,
} from "@/client/features/chat/reactions";
import { useMessageWork } from "./message-work-context";
import type { TimelineCommand } from "@/client/features/chat/reconcile";

/** Everything focusable inside a row; the article itself is not a descendant. */
const ROW_CONTROLS = "a[href], button, input, select, textarea, [tabindex]";

export function MessageRow({
  message,
  owner,
  name,
  own,
  canDeleteOthers = false,
  online,
  command,
  names,
  reply,
  forward,
  mentioned = false,
  jumped = false,
  active = false,
  grouped = false,
  divider,
}: {
  message: Message;
  owner: OwnerScope;
  name: string;
  own: boolean;
  canDeleteOthers?: boolean;
  online: boolean;
  names?: Map<string, string> | undefined;
  reply?: ((message: Message) => void) | undefined;
  forward?: ((message: Message) => void) | undefined;
  /** This message names the reader; the row carries a quiet accent. */
  mentioned?: boolean;
  /** The row a jump opened at: briefly highlighted and given focus. */
  jumped?: boolean;
  /** Carries the transcript's one tab stop; the arrow keys move it between rows. */
  active?: boolean;
  /** Continues the previous author's run: no repeated avatar or name. */
  grouped?: boolean;
  /** Day or unread marker rendered above the row. */
  divider?: ReactNode;
  command?: ((value: TimelineCommand) => Promise<unknown>) | undefined;
}) {
  const { t, text, formatTime, formatDateTime } = useI18n();
  const user = useOptionalUser();
  const detailsId = useId();
  const [actionsOpen, setActionsOpen] = useState(false);

  const { work, state } = useMessageWork(message.id);
  const { operation, error } = state;
  const pending = operation?.phase === "submitting";
  const retained = operation?.phase === "retained";
  const attempted = pending || retained;
  const setError = (error: UiMessage | null) =>
    work?.setError(message.id, error);
  const removingFile =
    operation?.kind === "remove-attachment"
      ? message.attachments.find(
          (file) => file.fileId === operation.attachment.fileId,
        )
      : undefined;
  const lifecycle = useRef({ active: true });
  useEffect(() => {
    const generation = { active: true };
    lifecycle.current = generation;
    return () => {
      generation.active = false;
    };
  }, []);
  // The row is the transcript's tab stop; its controls (quote actions, links,
  // files, reaction chips, the toolbar) are reached with the arrow keys instead
  // of each being a stop of its own. Edit and confirm scopes keep native order.
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = article.current;
    if (!element) return;
    const demote = () => {
      for (const control of element.querySelectorAll<HTMLElement>(
        ROW_CONTROLS,
      )) {
        if (control.closest("[data-focus-scope]")) {
          if (control.dataset.roving !== undefined) {
            control.removeAttribute("tabindex");
            delete control.dataset.roving;
          }
        } else if (control.getAttribute("tabindex") !== "-1") {
          control.setAttribute("tabindex", "-1");
          control.dataset.roving = "";
        }
      }
    };
    demote();
    const observer = new MutationObserver(demote);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  // Emoji this reader is toggling, until the owner's version comes back.
  const [reacting, setReacting] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const removalName =
    operation?.kind === "remove-attachment"
      ? (operation.phase === "preparing" ? removingFile : operation.attachment)
          ?.filename
      : undefined;
  function act() {
    if (!online || !user || !command || !work) return;
    if (operation?.kind === "delete" && !own && !canDeleteOthers) return;
    return work.submit(message, command);
  }
  async function react(emoji: ReactionEmoji, on: boolean) {
    if (!online || !user || !command || reacting.has(emoji)) return;
    const generation = lifecycle.current;
    setReacting((current) => new Map(current).set(emoji, on));
    setError(null);
    try {
      await command({
        operation: "react",
        body: {
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
          channelId: message.channelId,
          messageId: message.id,
          emoji,
          on,
        },
      });
    } catch (failure) {
      if (generation.active) setError(errorMessage(failure));
    } finally {
      // The accepted command already requested replay, which re-materialises
      // this row with the owner's counts. Local intent ends with the request.
      if (generation.active)
        setReacting((current) => {
          const next = new Map(current);
          next.delete(emoji);
          return next;
        });
    }
  }
  const canReact = Boolean(command) && !message.deletedAt && online;
  // What the reader's own reactions are right now, in-flight intent included.
  const mine = new Set(
    message.reactions
      .filter((reaction) => reaction.mine)
      .map((reaction) => reaction.emoji as string),
  );
  for (const [emoji, on] of reacting)
    if (on) mine.add(emoji);
    else mine.delete(emoji);
  const hasCommands =
    !message.deletedAt &&
    !operation &&
    online &&
    Boolean(command || reply || forward);
  const edited = message.version > 1 && !message.deletedAt;
  return (
    <MessageRowView
      ref={article}
      author={{ name, hue: personHue(message.authorId) }}
      time={{
        text: formatTime(message.createdAt),
        dateTime: new Date(message.createdAt).toISOString(),
        title: formatDateTime(message.createdAt),
      }}
      edited={edited ? t("chat.edited") : undefined}
      grouped={grouped}
      mentioned={mentioned}
      jumped={jumped}
      divider={divider}
      tabIndex={active ? 0 : -1}
      aria-describedby={detailsId}
      aria-haspopup={hasCommands ? "menu" : undefined}
      aria-expanded={hasCommands ? actionsOpen : undefined}
      aria-keyshortcuts={hasCommands ? "Enter Shift+F10" : undefined}
      data-actions-open={actionsOpen || undefined}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.defaultPrevented ||
          !hasCommands ||
          (event.key !== "Enter" &&
            event.key !== "ContextMenu" &&
            !(event.key === "F10" && event.shiftKey)) ||
          document.getSelection()?.isCollapsed === false
        )
          return;
        const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
          ".message-action-trigger",
        );
        if (!trigger) return;
        event.preventDefault();
        trigger.focus({ preventScroll: true });
        trigger.click();
      }}
    >
      <MessageContext
        message={message}
        owner={owner}
        names={names}
        online={online}
      />
      {message.deletedAt ? (
        <p className="text-ui text-muted italic">{t("chat.messageDeleted")}</p>
      ) : operation?.kind === "edit" ? (
        <form
          className="max-w-[65ch]"
          data-focus-scope=""
          onSubmit={(event) => {
            event.preventDefault();
            void act();
          }}
        >
          <MentionField
            draft={operation.draft}
            onDraftChange={(draft) => work?.changeDraft(message.id, draft)}
            owner={owner}
            channelId={message.channelId}
            online={online}
            className={`${fieldStyles} mb-2`}
            aria-label={t("chat.editMessage")}
            autoFocus
            disabled={!online || operation.phase !== "preparing"}
          />
          <div className={buttonRowStyles}>
            <button
              className={buttonStyles({
                variant: "primary",
                size: "small",
              })}
              disabled={pending || !online}
            >
              {attempted ? t("chat.retrySave") : t("chat.save")}
            </button>
            <button
              type="button"
              className={buttonStyles({
                variant: "quiet",
                size: "small",
              })}
              disabled={!online || pending}
              onClick={() => work?.cancel(message.id)}
            >
              {t("chat.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <BodyView
          body={message.body ?? ""}
          names={names}
          className={messageBodyStyles}
          trailing={
            grouped && edited ? (
              <span className="ml-2 text-fine text-muted">
                {t("chat.edited")}
              </span>
            ) : null
          }
        />
      )}
      {!message.deletedAt && (
        <MessageFiles
          attachments={message.attachments}
          owner={owner}
          online={online}
          removalDisabled={Boolean(operation)}
          {...(own && command
            ? {
                onRemove: (fileId: string) => {
                  const file = message.attachments.find(
                    (item) => item.fileId === fileId,
                  );
                  if (!file) return;
                  work?.beginRemoval(message.id, file);
                },
              }
            : {})}
        />
      )}
      {!message.deletedAt && (
        <ReactionPills
          reactions={message.reactions}
          pending={reacting}
          disabled={!canReact}
          onToggle={(emoji, on) => void react(emoji, on)}
        />
      )}
      {operation?.kind === "remove-attachment" && !message.deletedAt && (
        <ConfirmRow
          data-focus-scope=""
          question={
            removalName
              ? t("chat.confirmRemoveAttachment", { name: removalName })
              : t("chat.messageUnavailable")
          }
          detail={
            !message.body && !message.quote && message.attachments.length === 1
              ? t("chat.removeLastAttachment")
              : undefined
          }
          confirmLabel={
            attempted
              ? t("chat.retryRemoveAttachment")
              : t("chat.removeAttachment")
          }
          busyLabel={t("chat.loading")}
          busy={pending}
          disabled={!online || (!removingFile && !retained)}
          cancelLabel={t("chat.keepAttachment")}
          cancelDisabled={pending || !online || retained}
          onConfirm={() => void act()}
          onCancel={() => work?.cancel(message.id)}
        />
      )}
      {operation?.kind === "delete" && !message.deletedAt && (
        <ConfirmRow
          data-focus-scope=""
          question={t("chat.confirmDelete")}
          confirmLabel={
            attempted ? t("chat.retryDeletion") : t("chat.deleteMessage")
          }
          busyLabel={t("chat.loading")}
          busy={pending}
          disabled={!online || (!own && !canDeleteOthers)}
          cancelLabel={t("chat.keepMessage")}
          cancelDisabled={!online || pending}
          onConfirm={() => void act()}
          onCancel={() => work?.cancel(message.id)}
        />
      )}
      {error && (
        <p role="alert" className="text-ui text-error">
          {text(error)}
        </p>
      )}
      <div className="message-command-surface">
        <span id={detailsId} className="message-detail-time sr-only">
          {t("chat.messageDetails", {
            name,
            time: formatDateTime(message.createdAt),
          })}
        </span>
        {hasCommands && (
          <MessageCommands
            message={message}
            owner={owner}
            name={name}
            descriptionId={detailsId}
            react={
              canReact
                ? (emoji) => void react(emoji, !mine.has(emoji))
                : undefined
            }
            activeReactions={mine}
            reply={reply}
            forward={forward}
            edit={
              own && command
                ? () => {
                    work?.beginEdit(
                      message.id,
                      decodeMentionDraft(
                        message.body ?? "",
                        names,
                        t("chat.member"),
                      ),
                    );
                  }
                : undefined
            }
            remove={
              (own || canDeleteOthers) && command
                ? () => work?.beginDelete(message.id)
                : undefined
            }
            onOpenChange={setActionsOpen}
          />
        )}
      </div>
      <div
        data-sequence={message.createdSequence}
        aria-hidden="true"
        className="h-px"
      />
    </MessageRowView>
  );
}
