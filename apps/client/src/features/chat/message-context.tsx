import { useState } from "react";
import type { Message, OwnerScope } from "@vaskel/contracts/messaging";
import { quoteKind } from "@/client/features/chat/quote-selection";
import { QuoteView } from "@/client/features/chat/quote-view";
import { OriginalMessageDialog } from "@/client/features/chat/original-message-dialog";

export function MessageContext({
  message,
  owner,
  names,
  online = false,
}: {
  message: Message;
  /** Where this message lives, so its quote reads as a reply or a forward. */
  owner: OwnerScope;
  names?: Map<string, string> | undefined;
  online?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (message.deletedAt || !message.quote) return null;
  return (
    <>
      <QuoteView
        quote={message.quote}
        kind={quoteKind(message.quote.source, owner, message.channelId)}
        name={names?.get(message.quote.authorId)}
        names={names}
        {...(online ? { openOriginal: () => setOpen(true) } : {})}
      />
      {open && (
        <OriginalMessageDialog
          source={message.quote.source}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
