import type { Kysely } from "kysely";
import {
  QuoteSnapshotSchema,
  type QuoteReference,
  type QuoteSnapshot,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { access } from "./policy";

/** Trusted Worker-to-owner argument. Only its immutable flat snapshot is persisted. */
export interface CapturedQuote {
  selected: QuoteReference;
  snapshot: QuoteSnapshot;
}
export function sameQuoteReference(
  left: QuoteReference,
  right: QuoteReference,
) {
  return (
    left.owner.kind === right.owner.kind &&
    left.owner.id === right.owner.id &&
    left.channelId === right.channelId &&
    left.messageId === right.messageId
  );
}

/** Caller holds the source owner's native transaction, including same-owner sends. */
export async function captureQuoteInTransaction(
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  selected: QuoteReference,
): Promise<
  | { kind: "quote_captured"; capture: CapturedQuote }
  | { kind: "source_unavailable" }
> {
  const authorized = await access(database, principal, selected.channelId);
  if (
    authorized.kind !== "authorized" ||
    authorized.state.owner_kind !== selected.owner.kind ||
    authorized.state.owner_id !== selected.owner.id
  )
    return { kind: "source_unavailable" };
  const row = await database
    .selectFrom("messages")
    .selectAll()
    .where("channel_id", "=", selected.channelId)
    .where("id", "=", selected.messageId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row || row.body === null) return { kind: "source_unavailable" };
  const files = await database
    .selectFrom("attachments")
    .select("quarantined")
    .where("message_id", "=", row.id)
    .where("state", "=", "claimed")
    .execute();
  const snapshot =
    !row.body.trim() && files.length === 0 && row.quote_json
      ? QuoteSnapshotSchema.parse(JSON.parse(row.quote_json))
      : {
          source: selected,
          authorId: row.author_id,
          body: row.body,
          createdAt: row.created_at,
          version: row.version,
          attachmentCount: files.filter((file) => !file.quarantined).length,
        };
  return { kind: "quote_captured", capture: { selected, snapshot } };
}
