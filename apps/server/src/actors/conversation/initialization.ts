import type { Kysely } from "kysely";
import {
  type InitializeConversation,
  type InitializeOutcome,
} from "@vaskel/contracts/administration";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { getState, ownerScope } from "@/server/actors/shared/policy";
import { MESSAGE_SEARCH_POLICY } from "@/server/actors/shared/message-search";

export async function initializeConversation(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  input: InitializeConversation,
): Promise<InitializeOutcome> {
  const command = input;
  return storage.transaction(async () => {
    const pair = await database
      .selectFrom("direct_pair")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirst();
    if (
      pair &&
      (pair.conversation_id !== command.conversationId ||
        JSON.stringify([pair.first_user_id, pair.second_user_id]) !==
          JSON.stringify([...command.participantIds].sort()))
    )
      return { kind: "command_conflict" };
    const existing = await getState(database);
    if (existing) {
      const members = await database
        .selectFrom("members")
        .select("user_id")
        .orderBy("user_id")
        .execute();
      if (
        existing.owner_kind !== "conversation" ||
        existing.owner_id !== command.conversationId ||
        JSON.stringify(members.map((row) => row.user_id)) !==
          JSON.stringify([...command.participantIds].sort())
      )
        return { kind: "command_conflict" };
      return {
        kind: "initialized",
        owner: ownerScope(existing),
        version: existing.version,
        channelId: command.conversationId,
      };
    }
    await database
      .insertInto("owner_state")
      .values({
        id: 1,
        owner_kind: "conversation",
        owner_id: command.conversationId,
        name: "Direct conversation",
        version: 1,
        generation: crypto.randomUUID(),
        high_water: 0,
        replay_floor: 0,
        search_policy: MESSAGE_SEARCH_POLICY,
      })
      .execute();
    await database
      .insertInto("members")
      .values(
        command.participantIds.map((user_id) => ({
          user_id,
          role: "member" as const,
        })),
      )
      .execute();
    await database
      .insertInto("channels")
      .values({
        id: command.conversationId,
        name: "Direct conversation",
        private: 0,
        version: 1,
      })
      .execute();
    return {
      kind: "initialized",
      owner: { kind: "conversation", id: command.conversationId },
      version: 1,
      channelId: command.conversationId,
    };
  });
}
