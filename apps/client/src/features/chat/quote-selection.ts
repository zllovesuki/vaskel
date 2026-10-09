import type {
  Message,
  OwnerScope,
  QuoteReference,
  QuoteSnapshot,
} from "@vaskel/contracts/messaging";

/** A quote from the same room answers it; one carried in from elsewhere is a forward. */
export function quoteKind(
  source: QuoteReference,
  owner: OwnerScope,
  channelId: string,
): "reply" | "forward" {
  return source.owner.kind === owner.kind &&
    source.owner.id === owner.id &&
    source.channelId === channelId
    ? "reply"
    : "forward";
}

/** A local display seed; only its reference enters the Send command. */
export interface QuoteSelection {
  reference: QuoteReference;
  preview: QuoteSnapshot;
}
export function selectQuote(
  owner: OwnerScope,
  message: Message,
): QuoteSelection {
  const reference = {
    owner,
    channelId: message.channelId,
    messageId: message.id,
  };
  return {
    reference,
    preview:
      !message.body?.trim() && !message.attachments.length && message.quote
        ? message.quote
        : {
            source: reference,
            authorId: message.authorId,
            body: message.body ?? "",
            createdAt: message.createdAt,
            version: message.version,
            attachmentCount: message.attachments.length,
          },
  };
}
