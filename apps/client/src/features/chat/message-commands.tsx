import { Forward, Link2, Pencil, Reply, SmilePlus, Trash } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import type { Message, OwnerScope } from "@vaskel/contracts/messaging";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { resourceLocation } from "@/client/routes/resource-location";
import {
  messageActionIds,
  messageToolbarIds,
  type MessageActionId,
} from "@/client/features/chat/timeline-surface";
import type { ReactionEmoji } from "@/client/features/chat/reactions";
import { EmojiPicker } from "./emoji-picker";
import { ActionsMenu, type ActionsMenuItem } from "@/client/ui/actions-menu";
import { buttonStyles } from "@vaskel/ui/components/control-styles";

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/**
 * The content row anchors every toolbar below the optional author header.
 * Active touch rows reveal one 36px control; fine pointers reveal the full toolbar.
 */
const toolbarStyles =
  "message-actions absolute top-0 right-0 items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-row pointer-coarse:border-transparent pointer-coarse:bg-transparent pointer-coarse:p-0 pointer-coarse:shadow-none [@media(hover:none)]:border-transparent [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-0 [@media(hover:none)]:shadow-none";

export function MessageCommands({
  message,
  owner,
  name,
  descriptionId,
  react,
  activeReactions,
  reply,
  forward,
  edit,
  remove,
  onOpenChange,
}: {
  message: Message;
  owner: OwnerScope;
  name: string;
  descriptionId: string;
  /** Present when this reader may react; the palette opens from here. */
  react?: ((emoji: ReactionEmoji) => void) | undefined;
  activeReactions?: ReadonlySet<string> | undefined;
  reply?: ((message: Message) => void) | undefined;
  forward?: ((message: Message) => void) | undefined;
  edit?: (() => void) | undefined;
  remove?: (() => void) | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  // The anchor is state, not a ref: the picker positions against it on open.
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [status, setStatus] = useState<"copied" | "copy-failed" | null>(null);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 3_000);
    return () => clearTimeout(timer);
  }, [status]);
  const body = (
    message.body ||
    message.quote?.body ||
    message.attachments[0]?.filename ||
    ""
  )
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(
    graphemes.segment(body),
    (part) => part.segment,
  );
  const preview =
    characters.slice(0, 64).join("") + (characters.length > 64 ? "…" : "");
  function openPicker() {
    // Both entry points hand focus back here: the toolbar button keeps it, and
    // the menu returns it to More before running the item.
    opener.current = document.activeElement as HTMLElement | null;
    setPicker(true);
    onOpenChange(true);
  }
  function closePicker() {
    setPicker(false);
    onOpenChange(menu);
    opener.current?.focus({ preventScroll: true });
  }
  function copyLink() {
    const { href } = router.buildLocation({
      ...resourceLocation(owner, message.channelId),
      search: { at: message.createdSequence },
    });
    void navigator.clipboard
      .writeText(`${location.origin}${href}`)
      .then(() => setStatus("copied"))
      .catch(() => setStatus("copy-failed"));
  }
  const available = {
    react: Boolean(react),
    reply: Boolean(reply),
    forward: Boolean(forward),
    copyLink: true,
    edit: Boolean(edit),
    remove: Boolean(remove),
  };
  const labels: Record<MessageActionId, string> = {
    react: t("chat.react"),
    reply: t("chat.reply"),
    forward: t("chat.forward"),
    "copy-link": t("chat.copyLink"),
    edit: t("chat.editMessage"),
    delete: t("chat.deleteMessage"),
  };
  const icons: Record<MessageActionId, ReactNode> = {
    react: <SmilePlus aria-hidden="true" />,
    reply: <Reply aria-hidden="true" />,
    forward: <Forward aria-hidden="true" />,
    "copy-link": <Link2 aria-hidden="true" />,
    edit: <Pencil aria-hidden="true" />,
    delete: <Trash aria-hidden="true" />,
  };
  const run: Record<MessageActionId, () => void> = {
    react: openPicker,
    reply: () => reply?.(message),
    forward: () => forward?.(message),
    "copy-link": copyLink,
    edit: () => edit?.(),
    delete: () => remove?.(),
  };
  const items: ActionsMenuItem[] = messageActionIds(available).map((id) => ({
    id,
    label: labels[id],
    icon: icons[id],
    onSelect: run[id],
    ...(id === "delete" ? { destructive: true } : {}),
  }));
  return (
    <div className={toolbarStyles} ref={setToolbar}>
      {status && (
        <span
          role="status"
          className="mr-1 ml-1 text-fine whitespace-nowrap text-muted"
        >
          {status === "copied" ? t("workspace.copied") : t("chat.copyFailed")}
        </span>
      )}
      {messageToolbarIds(available).map((id) => (
        <button
          key={id}
          type="button"
          // Quiet icon controls for a fine pointer; More also serves touch.
          className={buttonStyles({
            variant: "muted",
            size: "icon-inset",
            className: "pointer-coarse:hidden [@media(hover:none)]:hidden",
          })}
          aria-label={labels[id]}
          aria-describedby={descriptionId}
          aria-haspopup={id === "react" ? "dialog" : undefined}
          aria-expanded={id === "react" ? picker : undefined}
          title={labels[id]}
          onClick={run[id]}
        >
          {icons[id]}
        </button>
      ))}
      <ActionsMenu
        label={t("chat.messageActionsFor", { name, preview })}
        buttonLabel={t("chat.moreActions")}
        descriptionId={descriptionId}
        buttonClass={buttonStyles({
          variant: "muted",
          size: "icon-inset",
          className:
            "message-action-trigger [@media(hover:none)]:size-control-normal",
        })}
        items={items}
        onOpenChange={(open) => {
          setMenu(open);
          onOpenChange(open || picker);
        }}
      />
      {react && (
        <EmojiPicker
          label={t("chat.addReaction")}
          open={picker}
          reference={toolbar}
          active={activeReactions ?? new Set()}
          onSelect={(emoji) => {
            closePicker();
            react(emoji);
          }}
          onOpenChange={(open) => {
            if (!open) closePicker();
          }}
        />
      )}
    </div>
  );
}
