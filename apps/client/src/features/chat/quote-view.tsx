import { useEffect, useId, useRef, useState } from "react";
import type { QuoteSnapshot } from "@vaskel/contracts/messaging";
import { BodyView, type MentionNames } from "@/client/features/chat/body-view";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  QuoteAction,
  QuoteBlock,
  quoteBodyStyles,
} from "@vaskel/ui/components/room";

/**
 * A quote with its behaviour: the clamp is measured, so Expand appears only
 * when the excerpt overflows, and Open original appears when there is a
 * dialog to open it in.
 */
export function QuoteView({
  quote,
  name,
  names,
  openOriginal,
  kind = "reply",
  plain = false,
}: {
  quote: QuoteSnapshot;
  name?: string | undefined;
  /** Names the captured body mentions, as far as the caller knows them. */
  names?: MentionNames | undefined;
  openOriginal?: (() => void) | undefined;
  /** Whether the quote answers its own room or was carried in from elsewhere. */
  kind?: "reply" | "forward";
  /** No fill or side padding: the surrounding frame already sets it apart. */
  plain?: boolean;
}) {
  const { t, formatNumber, formatTime, formatDateTime } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || expanded) return;
    // Measure the rendered clamp, including CJK wrapping, font changes and resize.
    const measure = () =>
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const frame = requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [quote.body, expanded]);
  const expandable = expanded || overflowing;
  return (
    <QuoteBlock
      label={t("chat.quotedReply")}
      kind={kind}
      author={name ?? t("chat.member")}
      time={{
        text: formatTime(quote.createdAt),
        dateTime: new Date(quote.createdAt).toISOString(),
        title: formatDateTime(quote.createdAt),
      }}
      action={
        openOriginal && (
          <QuoteAction onClick={openOriginal}>
            {t("chat.openOriginal")}
          </QuoteAction>
        )
      }
      plain={plain}
      attachments={
        quote.attachmentCount > 0
          ? t("chat.quotedAttachments", {
              count: formatNumber(quote.attachmentCount),
            })
          : undefined
      }
      expander={
        expandable ? (
          <QuoteAction
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? t("chat.collapseQuote") : t("chat.expandQuote")}
          </QuoteAction>
        ) : undefined
      }
    >
      {quote.body && (
        // BodyView owns the measured element, so the clamp still observes it.
        <BodyView
          ref={bodyRef}
          id={bodyId}
          body={quote.body}
          names={names}
          className={quoteBodyStyles({ expanded, plain })}
        />
      )}
    </QuoteBlock>
  );
}
