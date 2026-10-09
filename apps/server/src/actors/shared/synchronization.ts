import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  type MessagingOutcome,
  type AroundRequest,
  type OriginalMessageRequest,
  type OriginalMessageOutcome,
  type ReadRequest,
  type ReplayRequest,
  type SearchRequest,
  type SnapshotRequest,
} from "@vaskel/contracts/messaging";
import { CROSS_SEARCH_QUERY_MIN_CODE_POINTS } from "@vaskel/contracts/search";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { ftsPhrase } from "./message-search";
import { access, cursor } from "./policy";
import { materialize, materializeMessages } from "./message-materialization";

/** Source-local denial must not imply that the destination conversation is inaccessible. */
export async function originalMessage(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  request: OriginalMessageRequest,
): Promise<OriginalMessageOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return { kind: "source_unavailable" };
    const row = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", request.messageId)
      .where("channel_id", "=", request.channelId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row
      ? {
          kind: "original_message",
          message: await materialize(database, row, principal.userId),
        }
      : { kind: "source_unavailable" };
  });
}

export async function snapshotMessages(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: SnapshotRequest,
): Promise<MessagingOutcome> {
  const request = { ...input, limit: input.limit ?? 40 };
  return storage.transaction(async () => {
    const authorized = await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    let query = database
      .selectFrom("messages")
      .selectAll()
      .where("channel_id", "=", request.channelId)
      .orderBy("created_sequence", "desc")
      .limit(request.limit + 1);
    if (request.before !== undefined)
      query = query.where("created_sequence", "<", request.before);
    const rows = await query.execute();
    const page = rows.slice(0, request.limit);
    const read = await database
      .selectFrom("read_cursors")
      .select("sequence")
      .where("user_id", "=", principal.userId)
      .where("channel_id", "=", request.channelId)
      .executeTakeFirst();
    return {
      kind: "snapshot",
      messages: (
        await materializeMessages(database, page, principal.userId)
      ).reverse(),
      cursor: cursor(state, request.channelId),
      nextBefore:
        rows.length > request.limit
          ? (page.at(-1)?.created_sequence ?? null)
          : null,
      readSequence: read?.sequence ?? 0,
    };
  });
}

export async function replayMessages(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: ReplayRequest,
): Promise<MessagingOutcome> {
  const request = { ...input, limit: input.limit ?? 100 };
  return storage.transaction(async () => {
    const authorized = await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    const previous = request.cursor;
    if (
      previous.owner.id !== state.owner_id ||
      previous.owner.kind !== state.owner_kind ||
      previous.channelId !== request.channelId
    )
      return { kind: "reset_required", reason: "scope" };
    if (previous.generation !== state.generation)
      return { kind: "reset_required", reason: "generation" };
    if (previous.sequence < state.replay_floor)
      return { kind: "reset_required", reason: "floor" };
    if (previous.sequence > state.high_water)
      return { kind: "reset_required", reason: "ahead" };
    // Per-channel filtering is explicit. Cursor advances to the last page event when
    // truncated, and to owner head only after exhausting all remaining channel events.
    const rows = await database
      .selectFrom("events")
      .innerJoin("messages", "messages.id", "events.message_id")
      .selectAll("messages")
      .select(["events.sequence as event_sequence", "events.operation"])
      .where("events.channel_id", "=", request.channelId)
      .where("events.sequence", ">", previous.sequence)
      .orderBy("events.sequence")
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const page = rows.slice(0, request.limit);
    const progress = hasMore
      ? (page.at(-1)?.event_sequence ?? previous.sequence)
      : state.high_water;
    const messages = await materializeMessages(
      database,
      page,
      principal.userId,
    );
    return {
      kind: "replay",
      events: page.map((row, index) => ({
        sequence: row.event_sequence,
        operation: row.operation,
        message: messages[index]!,
      })),
      cursor: cursor(state, request.channelId, progress),
      highWater: state.high_water,
      hasMore,
    };
  });
}

export async function searchMessages(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: SearchRequest,
): Promise<MessagingOutcome> {
  const request = { ...input, limit: input.limit ?? 40 };
  return storage.transaction(async () => {
    const authorized = await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const phrase = ftsPhrase(request.query);
    if (phrase === null)
      return {
        kind: "query_too_short",
        minimum: CROSS_SEARCH_QUERY_MIN_CODE_POINTS,
      };
    // Retained tombstones must not make the live endpoint reads scan history.
    const { rows: ranges } = await sql<{
      oldest: number | null;
      newest: number | null;
    }>`SELECT
      (SELECT created_sequence FROM messages INDEXED BY messages_live_history
        WHERE channel_id = ${request.channelId} AND deleted_at IS NULL
        ORDER BY created_sequence ASC LIMIT 1) AS oldest,
      (SELECT created_sequence FROM messages INDEXED BY messages_live_history
        WHERE channel_id = ${request.channelId} AND deleted_at IS NULL
        ORDER BY created_sequence DESC LIMIT 1) AS newest`.execute(database);
    const range = ranges[0]!;
    if (range.oldest === null || range.newest === null)
      return { kind: "matches", messages: [] };
    // FTS rowids are creation positions. Keep FTS first so LIMIT can stop its
    // descending traversal; bounding it must not turn into a per-message MATCH.
    const result = await sql<
      import("./database").MessageRow
    >`SELECT messages.* FROM message_fts
      CROSS JOIN messages
      WHERE message_fts MATCH ${phrase}
        AND message_fts.rowid >= ${range.oldest}
        AND message_fts.rowid <= ${range.newest}
        AND messages.id = message_fts.message_id
        AND messages.channel_id = ${request.channelId}
        AND messages.deleted_at IS NULL
      ORDER BY message_fts.rowid DESC LIMIT ${request.limit}`.execute(database);
    return {
      kind: "matches",
      messages: await materializeMessages(
        database,
        result.rows,
        principal.userId,
      ),
    };
  });
}

export async function updateReadCursor(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: ReadRequest,
): Promise<MessagingOutcome> {
  const request = input;
  return storage.transaction(async () => {
    const authorized = await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const last = await database
      .selectFrom("messages")
      .select((expression) =>
        expression.fn.max<number>("created_sequence").as("sequence"),
      )
      .where("channel_id", "=", request.channelId)
      .executeTakeFirst();
    if (request.sequence > (last?.sequence ?? 0))
      return { kind: "invalid_input" };
    const previous = await database
      .selectFrom("read_cursors")
      .selectAll()
      .where("user_id", "=", principal.userId)
      .where("channel_id", "=", request.channelId)
      .executeTakeFirst();
    const sequence = Math.max(request.sequence, previous?.sequence ?? 0);
    if (previous?.sequence === sequence)
      return { kind: "read_updated", sequence };
    await database
      .insertInto("read_cursors")
      .values({
        user_id: principal.userId,
        channel_id: request.channelId,
        sequence,
      })
      .onConflict((conflict) =>
        conflict.columns(["user_id", "channel_id"]).doUpdateSet({ sequence }),
      )
      .execute();
    return { kind: "read_updated", sequence };
  });
}

/** A bounded pair of indexed ranges preserves the normal chronological timeline. */
export async function aroundMessages(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  request: AroundRequest,
): Promise<MessagingOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const limit = request.limit ?? 40;
    const result = await sql<import("./database").MessageRow>`
      SELECT * FROM (
        SELECT * FROM messages WHERE channel_id = ${request.channelId}
          AND created_sequence <= ${request.sequence}
        ORDER BY created_sequence DESC LIMIT ${limit + 1}
      ) UNION ALL SELECT * FROM (
        SELECT * FROM messages WHERE channel_id = ${request.channelId}
          AND created_sequence > ${request.sequence}
        ORDER BY created_sequence ASC LIMIT ${limit + 1}
      ) ORDER BY created_sequence ASC
    `.execute(database);
    const rows = result.rows;
    const anchor = rows.findIndex(
      (row) => row.created_sequence === request.sequence,
    );
    if (anchor < 0) return { kind: "not_found" };
    const start = Math.max(
      0,
      Math.min(anchor - Math.floor((limit - 1) / 2), rows.length - limit),
    );
    const page = rows.slice(start, start + limit);
    const read = await database
      .selectFrom("read_cursors")
      .select("sequence")
      .where("user_id", "=", principal.userId)
      .where("channel_id", "=", request.channelId)
      .executeTakeFirst();
    return {
      kind: "around",
      messages: await materializeMessages(database, page, principal.userId),
      cursor: cursor(authorized.state, request.channelId),
      nextBefore: start > 0 ? page[0]!.created_sequence : null,
      nextAfter:
        start + page.length < rows.length
          ? page.at(-1)!.created_sequence
          : null,
      readSequence: read?.sequence ?? 0,
    };
  });
}
