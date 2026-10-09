import { ParseJSONResultsPlugin, type Kysely } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import {
  QuoteSnapshotSchema,
  ReactionEmojiSchema,
  type Message,
} from "@vaskel/contracts/messaging";
import type { MessageRow, OwnerDatabase } from "./database";
import { descriptor } from "./attachments/state";

// Leave room for reader IDs and predicates within the native 100-parameter limit.
const DETAIL_BATCH_SIZE = 50;
type MessageDetails = Pick<Message, "attachments" | "reactions" | "mentions">;

async function readDetails(
  database: Kysely<OwnerDatabase>,
  rows: readonly MessageRow[],
  readerId?: string,
) {
  const ids = [
    ...new Set(
      rows.filter((row) => row.deleted_at === null).map((row) => row.id),
    ),
  ];
  const details = new Map<string, MessageDetails>();
  for (let offset = 0; offset < ids.length; offset += DETAIL_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + DETAIL_BATCH_SIZE);
    const results = await database
      .selectFrom("messages")
      .select("id")
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom("attachments")
            .select(["id", "filename", "byte_length"])
            .whereRef("message_id", "=", "messages.id")
            .where("state", "=", "claimed")
            .where("quarantined", "=", 0)
            .orderBy("ordinal"),
        ).as("attachments"),
        jsonArrayFrom(
          eb
            .selectFrom("reactions")
            .select("emoji")
            .select((eb) => [
              eb.fn.countAll<number>().as("count"),
              (readerId === undefined
                ? eb.val(0)
                : eb.fn.max<number>(
                    eb
                      .case()
                      .when("user_id", "=", readerId)
                      .then(1)
                      .else(0)
                      .end(),
                  )
              ).as("mine"),
            ])
            .whereRef("message_id", "=", "messages.id")
            .groupBy("emoji")
            .orderBy("emoji"),
        ).as("reactions"),
        jsonArrayFrom(
          eb
            .selectFrom("mentions")
            .select("user_id")
            .whereRef("message_id", "=", "messages.id")
            .orderBy("user_id"),
        ).as("mentions"),
      ])
      .where("id", "in", chunk)
      .withPlugin(
        new ParseJSONResultsPlugin({
          // Decode only the aggregate columns. JSON-looking filenames and IDs stay text.
          shouldParse: (_value, path) =>
            /^\$\[\d+\]\."(attachments|reactions|mentions)"$/.test(path),
        }),
      )
      .execute();
    for (const result of results) {
      details.set(result.id, {
        attachments: result.attachments.map(descriptor),
        reactions: result.reactions.map((reaction) => ({
          emoji: ReactionEmojiSchema.parse(reaction.emoji),
          count: reaction.count,
          mine: reaction.mine === 1,
        })),
        mentions: result.mentions.map((mention) => mention.user_id),
      });
    }
  }
  return details;
}

function assemble(
  row: MessageRow,
  details: MessageDetails | undefined,
): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    body: row.deleted_at === null ? row.body : null,
    ...(row.deleted_at === null && details
      ? details
      : { attachments: [], reactions: [], mentions: [] }),
    ...(row.deleted_at === null && row.quote_json
      ? { quote: QuoteSnapshotSchema.parse(JSON.parse(row.quote_json)) }
      : {}),
    version: row.version,
    createdSequence: row.created_sequence,
    updatedSequence: row.updated_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** Already-authorized current rows, in caller order, within the caller's native transaction. */
export async function materializeMessages(
  database: Kysely<OwnerDatabase>,
  rows: readonly MessageRow[],
  readerId: string,
): Promise<Message[]> {
  const details = await readDetails(database, rows, readerId);
  // Replay can repeat a current message; convert it only once in this call.
  const messages = new Map<string, Message>();
  return rows.map((row) => {
    const existing = messages.get(row.id);
    if (existing) return existing;
    const message = assemble(row, details.get(row.id));
    messages.set(row.id, message);
    return message;
  });
}

export async function materialize(
  database: Kysely<OwnerDatabase>,
  row: MessageRow,
  readerId: string,
): Promise<Message> {
  const details = await readDetails(database, [row], readerId);
  return assemble(row, details.get(row.id));
}

/** Broadcast-local reuse only; each socket still needs authorization at delivery. */
export async function materializeForReaders(
  database: Kysely<OwnerDatabase>,
  row: MessageRow,
  readerIds: readonly string[],
): Promise<Map<string, Message>> {
  const readers = [...new Set(readerIds)];
  if (readers.length === 0) return new Map();
  const details = await readDetails(database, [row]);
  const message = assemble(row, details.get(row.id));
  const membership = new Map<string, Set<string>>();
  if (message.reactions.length > 0) {
    for (let offset = 0; offset < readers.length; offset += DETAIL_BATCH_SIZE) {
      const reactions = await database
        .selectFrom("reactions")
        .select(["user_id", "emoji"])
        .where("message_id", "=", row.id)
        .where(
          "user_id",
          "in",
          readers.slice(offset, offset + DETAIL_BATCH_SIZE),
        )
        .execute();
      for (const reaction of reactions) {
        const mine = membership.get(reaction.user_id) ?? new Set<string>();
        mine.add(reaction.emoji);
        membership.set(reaction.user_id, mine);
      }
    }
  }
  return new Map(
    readers.map((readerId) => [
      readerId,
      {
        ...message,
        reactions: message.reactions.map((reaction) => ({
          ...reaction,
          mine: membership.get(readerId)?.has(reaction.emoji) ?? false,
        })),
      },
    ]),
  );
}
