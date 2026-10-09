import type { Kysely } from "kysely";
import { mentionTokens } from "@vaskel/contracts/message-text";
import type {
  MessagingFailure,
  ReactMessage,
} from "@vaskel/contracts/messaging";
import type { MessageRow, OwnerDatabase } from "./database";
import { channelReaders } from "./policy";

/** Called only inside the command's native owner transaction; returns the mentioned readers. */
export async function replaceMentions(
  database: Kysely<OwnerDatabase>,
  message: MessageRow,
): Promise<string[]> {
  const candidates = new Set(
    mentionTokens(message.body ?? "").map((mention) => mention.userId),
  );
  await database
    .deleteFrom("mentions")
    .where("message_id", "=", message.id)
    .execute();
  if (candidates.size === 0) return [];
  const allowed = new Set(
    (await channelReaders(database, message.channel_id).execute()).map(
      (reader) => reader.user_id,
    ),
  );
  const mentioned = [...candidates]
    .filter((id) => allowed.has(id))
    .slice(0, 20);
  if (mentioned.length > 0)
    await database
      .insertInto("mentions")
      .values(
        mentioned.map((userId) => ({
          message_id: message.id,
          user_id: userId,
          channel_id: message.channel_id,
          created_sequence: message.created_sequence,
        })),
      )
      .execute();
  return mentioned;
}

/** Reactions mutate the delivery sequence without consuming an edit version. */
export async function reactToMessage(
  database: Kysely<OwnerDatabase>,
  userId: string,
  command: ReactMessage,
  sequence: number,
  now: number,
): Promise<MessageRow | MessagingFailure> {
  const existing = await database
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", command.messageId)
    .where("channel_id", "=", command.channelId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!existing) return { kind: "not_found" };
  if (command.on) {
    const emojis = await database
      .selectFrom("reactions")
      .select("emoji")
      .distinct()
      .where("message_id", "=", existing.id)
      .execute();
    if (
      emojis.length >= 20 &&
      !emojis.some((row) => row.emoji === command.emoji)
    )
      return { kind: "capacity" };
    await database
      .insertInto("reactions")
      .values({
        message_id: existing.id,
        user_id: userId,
        emoji: command.emoji,
        created_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["message_id", "user_id", "emoji"]).doNothing(),
      )
      .execute();
  } else {
    await database
      .deleteFrom("reactions")
      .where("message_id", "=", existing.id)
      .where("user_id", "=", userId)
      .where("emoji", "=", command.emoji)
      .execute();
  }
  await database
    .updateTable("messages")
    .set({ updated_sequence: sequence, updated_at: now })
    .where("id", "=", existing.id)
    .execute();
  return { ...existing, updated_sequence: sequence, updated_at: now };
}
