import type {
  NotificationEligibleMessage,
  NotificationMessageReference,
  NotificationMessageQuery,
} from "@/server/notifications/protocol";
import { sql, type Kysely } from "kysely";
import { QuoteSnapshotSchema } from "@vaskel/contracts/messaging";
import { NOTIFICATION_GROUP_LIMIT } from "@vaskel/contracts/notifications";
import type { OwnerDatabase } from "./database";
import { getState, membership, visibleChannels } from "./policy";
import { newSendFailure } from "./send-policy";

/** A DM addresses every participant; elsewhere a mention or a quote of the reader's message does. */
export function isDirectRecipient(
  ownerKind: "server" | "conversation",
  mentioned: boolean,
  quoteAuthorId: string | undefined,
  readerId: string,
) {
  return (
    ownerKind === "conversation" || mentioned || quoteAuthorId === readerId
  );
}

/** Private binding RPC only: no session is fabricated and no content HTTP route exposes it. */
export function selectNotificationMessage(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  accountId: string,
  references: NotificationMessageReference[],
  query: NotificationMessageQuery,
): Promise<NotificationEligibleMessage | null> {
  // The caller groups a bounded conversation burst; reject oversized internal requests.
  if (references.length === 0 || references.length > NOTIFICATION_GROUP_LIMIT)
    return Promise.resolve(null);
  return storage.transaction(async () => {
    const state = await getState(database);
    if (
      !state ||
      !(await membership(database, accountId)) ||
      (await newSendFailure(database, state))
    )
      return null;
    const current = references.filter(
      (reference) =>
        reference.owner.id === state.owner_id &&
        reference.owner.kind === state.owner_kind &&
        reference.ownerGeneration === state.generation,
    );
    if (current.length === 0) return null;
    // One request may contain several rooms. Reuse authority and reads by room,
    // never by the first reference; the group limit keeps both IN sets bounded.
    const rooms = await database
      .selectFrom("channels")
      .leftJoin("read_cursors", (join) =>
        join
          .onRef("read_cursors.channel_id", "=", "channels.id")
          .on("read_cursors.user_id", "=", accountId),
      )
      .select(["channels.id", "channels.name", "read_cursors.sequence"])
      .where("channels.id", "in", [
        ...new Set(current.map((reference) => reference.roomId)),
      ])
      .where((eb) => visibleChannels(eb, accountId))
      .execute();
    const byRoom = new Map(rooms.map((room) => [room.id, room]));
    const unread = current.flatMap((reference) => {
      const channel = byRoom.get(reference.roomId);
      return channel && (channel.sequence ?? 0) < reference.sequence
        ? [{ reference, channel }]
        : [];
    });
    if (unread.length === 0) return null;
    const messages = await database
      .selectFrom("messages")
      .select([
        "id",
        "channel_id",
        "created_sequence",
        "created_at",
        "quote_json",
      ])
      .select(query.includeText ? "body" : sql<string | null>`NULL`.as("body"))
      .where("id", "in", [
        ...new Set(unread.map(({ reference }) => reference.messageId)),
      ])
      .where("channel_id", "in", [
        ...new Set(unread.map(({ reference }) => reference.roomId)),
      ])
      .where("author_id", "!=", accountId)
      .where("deleted_at", "is", null)
      .execute();
    const byMessage = new Map(messages.map((message) => [message.id, message]));
    const matching = unread.flatMap(({ reference, channel }) => {
      const message = byMessage.get(reference.messageId);
      return message &&
        message.channel_id === reference.roomId &&
        message.created_sequence === reference.sequence &&
        message.created_at === reference.createdAt
        ? [{ reference, channel, message }]
        : [];
    });
    if (matching.length === 0) return null;
    const mentions = new Set(
      state.owner_kind === "conversation"
        ? []
        : (
            await database
              .selectFrom("mentions")
              .select("message_id")
              .where("message_id", "in", [
                ...new Set(matching.map(({ message }) => message.id)),
              ])
              .where("user_id", "=", accountId)
              .execute()
          ).map((mention) => mention.message_id),
    );
    // Select before transferring text. Stable sorting keeps the existing tie rule.
    matching.sort((a, b) => b.reference.createdAt - a.reference.createdAt);
    for (const { reference, channel, message } of matching) {
      const quote = message.quote_json
        ? QuoteSnapshotSchema.parse(JSON.parse(message.quote_json))
        : null;
      const direct = isDirectRecipient(
        state.owner_kind,
        mentions.has(message.id),
        quote?.authorId,
        accountId,
      );
      if (query.directOnly && !direct) continue;
      return {
        reference,
        trigger: direct ? "direct" : "all",
        senderLabel: reference.senderLabel.slice(0, 128),
        roomLabel:
          state.owner_kind === "conversation" ? "" : channel.name.slice(0, 128),
        text: query.includeText
          ? message.body?.trim() || quote?.body.trim() || ""
          : null,
      };
    }
    return null;
  });
}
