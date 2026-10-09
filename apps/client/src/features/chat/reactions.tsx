import {
  type Message,
  type REACTION_EMOJIS,
} from "@vaskel/contracts/messaging";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { ReactionBar, ReactionPill } from "@vaskel/ui/components/room";

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

/**
 * The reactions a message carries. Counts are the owner's: a toggle shows the
 * viewer's own intent immediately and waits for replay to re-materialise the
 * row, so no count is ever invented here.
 */
export function ReactionPills({
  reactions,
  pending,
  disabled = false,
  onToggle,
}: {
  reactions: Message["reactions"];
  /** Emoji to the viewer's in-flight intent, until replay confirms it. */
  pending: ReadonlyMap<string, boolean>;
  disabled?: boolean;
  onToggle: (emoji: ReactionEmoji, on: boolean) => void;
}) {
  const { t, formatNumber } = useI18n();
  const shown = [
    ...reactions.map((reaction) => ({
      emoji: reaction.emoji,
      count: reaction.count,
      mine: pending.get(reaction.emoji) ?? reaction.mine,
      settled: !pending.has(reaction.emoji),
    })),
    // A first reaction with this emoji has no count until the owner answers.
    ...[...pending]
      .filter(
        ([emoji, on]) =>
          on && !reactions.some((reaction) => reaction.emoji === emoji),
      )
      .map(([emoji]) => ({
        emoji: emoji as ReactionEmoji,
        count: 0,
        mine: true,
        settled: false,
      })),
  ];
  if (shown.length === 0) return null;
  return (
    <ReactionBar>
      {shown.map((reaction) => (
        <ReactionPill
          key={reaction.emoji}
          emoji={reaction.emoji}
          count={reaction.count > 0 ? formatNumber(reaction.count) : undefined}
          mine={reaction.mine}
          settled={reaction.settled}
          disabled={disabled}
          // An unconfirmed toggle has no count of its own to announce yet.
          aria-label={
            reaction.count > 0 && reaction.settled
              ? t("chat.reactionTally", {
                  name: t(`chat.reaction.${reaction.emoji}`),
                  count: formatNumber(reaction.count),
                })
              : t(`chat.reaction.${reaction.emoji}`)
          }
          onClick={() => onToggle(reaction.emoji, !reaction.mine)}
        />
      ))}
    </ReactionBar>
  );
}
