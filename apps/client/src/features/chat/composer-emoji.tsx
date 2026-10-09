import { useId, useState, type RefObject } from "react";
import { Smile } from "lucide-react";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { EmojiPicker } from "./emoji-picker";
import type { MentionFieldHandle } from "./mention-field";

/** Keyed by edit admission, so a lost connection retires an open picker. */
export function ComposerEmoji({
  disabled,
  field,
  textarea,
  onTyping,
}: {
  disabled: boolean;
  field: RefObject<MentionFieldHandle | null>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState<HTMLButtonElement | null>(null);
  const id = useId();
  return (
    <>
      <button
        type="button"
        ref={setReference}
        className={buttonStyles({ variant: "muted", size: "icon" })}
        aria-label={t("chat.insertEmoji")}
        title={t("chat.insertEmoji")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Smile aria-hidden="true" />
      </button>
      <EmojiPicker
        id={id}
        label={t("chat.insertEmoji")}
        open={open}
        reference={reference}
        returnFocus={textarea}
        onOpenChange={setOpen}
        onSelect={(emoji) => {
          setOpen(false);
          if (disabled) return;
          field.current?.insertText(emoji);
          onTyping?.();
        }}
      />
    </>
  );
}
