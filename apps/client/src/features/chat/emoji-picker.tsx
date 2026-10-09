import { useRef, useState, type RefObject } from "react";
import { useDismiss, useInteractions, useRole } from "@floating-ui/react";
import { REACTION_EMOJIS } from "@vaskel/contracts/messaging";
import { FloatingPanel } from "@/client/ui/floating-panel";
import { useFloatingPanel } from "@/client/ui/use-floating-panel";
import { useI18n } from "@/client/features/i18n/use-i18n";

type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
/** Six across keeps the 24 reactions to four rows on the narrowest phone. */
const COLUMNS = 6;

/**
 * The palette, anchored to whichever control opened it. Focus enters the grid,
 * arrows move within it, Enter selects and Escape returns focus to the opener.
 */
export function EmojiPicker({
  id,
  open,
  label,
  returnFocus = true,
  reference,
  active,
  onSelect,
  onOpenChange,
}: {
  id?: string;
  open: boolean;
  label: string;
  returnFocus?: boolean | RefObject<HTMLElement | null>;
  reference: HTMLElement | null;
  /** Emoji the viewer has already reacted with, including in-flight intent. */
  active?: ReadonlySet<string> | undefined;
  onSelect: (emoji: ReactionEmoji) => void;
  onOpenChange: (open: boolean) => void;
}) {
  // The opener is `reference`, which the caller renders and owns.
  const { setReference: _, ...position } = useFloatingPanel({
    open,
    onOpenChange,
    gap: 6,
    reference,
  });
  const { getFloatingProps } = useInteractions([
    useDismiss(position.context),
    useRole(position.context, { role: "dialog" }),
  ]);
  if (!open) return null;
  return (
    <FloatingPanel
      {...position}
      focus={{ initialFocus: 0, returnFocus }}
      size="picker"
      aria-label={label}
      {...getFloatingProps(id ? { id } : {})}
    >
      {/* Mounted per opening, so the grid always starts at its first key. */}
      <EmojiGrid label={label} active={active} onSelect={onSelect} />
    </FloatingPanel>
  );
}

function EmojiGrid({
  label,
  active,
  onSelect,
}: {
  label: string;
  active?: ReadonlySet<string> | undefined;
  onSelect: (emoji: ReactionEmoji) => void;
}) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (next: number) => {
    const index = Math.max(0, Math.min(REACTION_EMOJIS.length - 1, next));
    setActiveIndex(index);
    items.current[index]?.focus({ preventScroll: true });
  };
  // The caption names the emoji under the pointer, else the focused one, so
  // sighted readers get the same name assistive technology already hears.
  const named = REACTION_EMOJIS[hovered ?? activeIndex] ?? REACTION_EMOJIS[0];
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-6 gap-0.5"
      onMouseLeave={() => setHovered(null)}
      onKeyDown={(event) => {
        const steps: Record<string, number> = {
          ArrowRight: 1,
          ArrowLeft: -1,
          ArrowDown: COLUMNS,
          ArrowUp: -COLUMNS,
        };
        const step = steps[event.key];
        if (step !== undefined) {
          event.preventDefault();
          move(activeIndex + step);
        } else if (event.key === "Home") {
          event.preventDefault();
          move(0);
        } else if (event.key === "End") {
          event.preventDefault();
          move(REACTION_EMOJIS.length - 1);
        }
      }}
    >
      {REACTION_EMOJIS.map((emoji, index) => (
        <button
          key={emoji}
          ref={(element) => {
            items.current[index] = element;
          }}
          type="button"
          // One stop for the whole grid; the arrow keys move within it.
          tabIndex={activeIndex === index ? 0 : -1}
          aria-pressed={active?.has(emoji)}
          aria-label={t(`chat.reaction.${emoji}`)}
          title={t(`chat.reaction.${emoji}`)}
          // An emoji already chosen keeps its accent under the pointer and keyboard.
          className="inline-flex size-control-touch items-center justify-center rounded-lg text-lg hover:bg-wash focus-visible:bg-wash active:bg-press aria-pressed:bg-accent-soft aria-pressed:hover:bg-accent-soft-hover aria-pressed:focus-visible:bg-accent-soft-hover"
          onFocus={() => setActiveIndex(index)}
          onMouseEnter={() => setHovered(index)}
          onClick={() => onSelect(emoji)}
        >
          <span aria-hidden="true">{emoji}</span>
        </button>
      ))}
      <p
        className="col-span-full mt-1 truncate border-t border-line px-1 pt-1.5 text-fine text-muted"
        aria-hidden="true"
      >
        {t(`chat.reaction.${named}`)}
      </p>
    </div>
  );
}
