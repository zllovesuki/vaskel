import { expressionBuilder, sql, type Kysely } from "kysely";
import {
  CROSS_SEARCH_QUERY_MIN_CODE_POINTS,
  type MaterializeSearchOutcome,
  type MaterializeSearchRequest,
  type SearchCandidate,
  type SearchCandidatesOutcome,
  type SearchCandidatesRequest,
  type SearchPosition,
} from "@vaskel/contracts/search";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { materializeMessages } from "@/server/actors/shared/message-materialization";
import { ftsPhrase } from "@/server/actors/shared/message-search";
import { access, visibleChannels } from "@/server/actors/shared/policy";

/** Both phases filter authority before selecting keys or reading message rows. */
function permittedMessages(userId: string, channelId: string | undefined) {
  return sql<boolean>`
    EXISTS (SELECT 1 FROM members WHERE members.user_id = ${userId})
    AND ${visibleChannels(expressionBuilder<OwnerDatabase, "channels">(), userId)}
    AND messages.deleted_at IS NULL
    ${channelId === undefined ? sql`` : sql`AND messages.channel_id = ${channelId}`}
  `;
}

/** Every owner resumes below the same global creation tuple, including ID ties. */
function belowPosition(serverId: string, before: SearchPosition | undefined) {
  if (before === undefined) return sql``;
  return sql`AND (
    messages.created_at < ${before.createdAt}
    OR (messages.created_at = ${before.createdAt}
      AND messages.created_sequence < ${before.createdSequence})
    OR (messages.created_at = ${before.createdAt}
      AND messages.created_sequence = ${before.createdSequence}
      AND (${serverId} COLLATE BINARY > ${before.serverId}
        OR (${serverId} COLLATE BINARY = ${before.serverId}
          AND messages.id COLLATE BINARY > ${before.messageId})))
  )`;
}

export async function searchCandidates(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  request: SearchCandidatesRequest,
): Promise<SearchCandidatesOutcome> {
  return storage.transaction(async () => {
    const authorized =
      request.channelId === undefined
        ? await access(database, principal)
        : await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    const phrase = ftsPhrase(request.query);
    if (phrase === null)
      return {
        kind: "query_too_short",
        minimum: CROSS_SEARCH_QUERY_MIN_CODE_POINTS,
      };
    const { rows } = await sql<SearchCandidate>`
      SELECT messages.id AS messageId, messages.created_at AS createdAt,
        messages.created_sequence AS createdSequence, messages.version AS version
      FROM message_fts
      JOIN messages ON messages.id = message_fts.message_id
      JOIN channels ON channels.id = messages.channel_id
      WHERE message_fts MATCH ${phrase}
        AND ${permittedMessages(principal.userId, request.channelId)}
        ${belowPosition(state.owner_id, request.before)}
      ORDER BY messages.created_at DESC, messages.created_sequence DESC,
        messages.id COLLATE BINARY ASC
      LIMIT ${request.limit + 1}
    `.execute(database);
    return {
      kind: "search_candidates",
      candidates: rows,
    };
  });
}

export async function materializeSearch(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  request: MaterializeSearchRequest,
): Promise<MaterializeSearchOutcome> {
  return storage.transaction(async () => {
    const authorized =
      request.channelId === undefined
        ? await access(database, principal)
        : await access(database, principal, request.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    const rows = await database
      .selectFrom("messages")
      .innerJoin("channels", "channels.id", "messages.channel_id")
      .selectAll("messages")
      .select("channels.name as channel_name")
      .where(permittedMessages(principal.userId, request.channelId))
      .where(
        "messages.id",
        "in",
        request.candidates.map((key) => key.messageId),
      )
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Changed/deleted selections are omitted; current access still gates every body.
    const selected = request.candidates.flatMap((candidate) => {
      const row = byId.get(candidate.messageId);
      return row &&
        row.version === candidate.version &&
        row.created_at === candidate.createdAt &&
        row.created_sequence === candidate.createdSequence
        ? [row]
        : [];
    });
    const messages = await materializeMessages(
      database,
      selected,
      principal.userId,
    );
    const hits = selected.map((row, index) => ({
      channel: { id: row.channel_id, name: row.channel_name },
      message: messages[index]!,
    }));
    return {
      kind: "search_materialized",
      serverId: state.owner_id,
      serverName: state.name,
      hits,
    };
  });
}
