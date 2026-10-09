import { sql, type Kysely } from "kysely";
import {
  ACTIVITY_CHANNEL_PAGE_SIZE,
  type ActivityRequest,
  type OwnerActivityOutcome,
} from "@vaskel/contracts/activity";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { access, ownerScope, visibleChannels } from "./policy";

/** Current access and private read state are one owner-local, read-only snapshot. */
export async function activity(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  request: ActivityRequest,
): Promise<OwnerActivityOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    let query = database
      .selectFrom("channels")
      .select("channels.id")
      .select(
        sql<number>`(
          SELECT COUNT(*) FROM (
            SELECT 1 FROM messages
            WHERE channel_id = channels.id
              AND created_sequence > COALESCE((
                SELECT sequence FROM read_cursors
                WHERE channel_id = channels.id AND user_id = ${principal.userId}
              ), 0)
              AND deleted_at IS NULL
              AND author_id != ${principal.userId}
            LIMIT 100
          )
        )`.as("unread_count"),
      )
      .select(
        sql<number>`(
        SELECT COUNT(*) FROM (
          SELECT 1 FROM mentions JOIN messages ON messages.id = mentions.message_id
          WHERE mentions.channel_id = channels.id AND mentions.user_id = ${principal.userId}
            AND mentions.created_sequence > COALESCE((SELECT sequence FROM read_cursors WHERE channel_id = channels.id AND user_id = ${principal.userId}), 0)
            AND messages.deleted_at IS NULL AND messages.author_id != ${principal.userId}
          LIMIT 100
        )
      )`.as("mention_count"),
      )
      .select((expression) => [
        expression
          .selectFrom("messages")
          .select("created_sequence")
          .whereRef("messages.channel_id", "=", "channels.id")
          .orderBy("created_sequence", "desc")
          .limit(1)
          .as("last_created_sequence"),
        expression
          .selectFrom("read_cursors")
          .select("sequence")
          .where("user_id", "=", principal.userId)
          .whereRef("read_cursors.channel_id", "=", "channels.id")
          .as("read_sequence"),
      ])
      .where((eb) => visibleChannels(eb, principal.userId))
      .orderBy("channels.id")
      .limit(ACTIVITY_CHANNEL_PAGE_SIZE + 1);
    if (request.after) query = query.where("channels.id", ">", request.after);
    const rows = await query.execute();
    const page = rows.slice(0, ACTIVITY_CHANNEL_PAGE_SIZE);
    return {
      kind: "owner_activity",
      owner: ownerScope(authorized.state),
      generation: authorized.state.generation,
      channels: page.map((row) => {
        // Positions retain tombstones and own messages; the capped count only
        // includes unread arrivals from others. Edits cannot create arrivals.
        const lastCreatedSequence = row.last_created_sequence ?? 0;
        const readSequence = row.read_sequence ?? 0;
        return {
          channelId: row.id,
          lastCreatedSequence,
          readSequence,
          unreadCount: row.unread_count,
          mentionCount: row.mention_count,
          hasUnread: row.unread_count > 0,
        };
      }),
      nextCursor:
        rows.length > ACTIVITY_CHANNEL_PAGE_SIZE
          ? (page.at(-1)?.id ?? null)
          : null,
    };
  });
}
