import type { Kysely } from "kysely";
import {
  type ChangeChannelMemberSchema,
  type CreateChannelSchema,
  type RemoveMemberSchema,
  type AdministrationOutcome,
  type InitializeServer,
  type InitializeOutcome,
} from "@vaskel/contracts/administration";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { queueMediaInvalidations } from "@/server/actors/shared/media-invalidations";
import { growthCapacityFailure } from "@/server/actors/shared/capacity";
import { MESSAGE_SEARCH_POLICY } from "@/server/actors/shared/message-search";
import {
  getState,
  membership,
  ownerAccess,
  ownerScope,
  visibleChannels,
} from "@/server/actors/shared/policy";

export async function initializeServer(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  input: InitializeServer,
): Promise<InitializeOutcome> {
  const command = input;
  const firstChannelName = command.firstChannelName ?? "general";
  return storage.transaction(async () => {
    const existing = await getState(database);
    if (existing) {
      const creation = await database
        .selectFrom("server_initialization")
        .selectAll()
        .where("id", "=", 1)
        .executeTakeFirst();
      if (
        existing.owner_kind !== "server" ||
        existing.owner_id !== command.serverId ||
        creation?.name !== command.name ||
        creation.owner_id !== command.ownerId ||
        creation.first_channel_name !== firstChannelName
      )
        return { kind: "command_conflict" };
      return {
        kind: "initialized",
        owner: ownerScope(existing),
        version: existing.version,
        channelId: command.serverId,
      };
    }
    await database
      .insertInto("owner_state")
      .values({
        id: 1,
        owner_kind: "server",
        owner_id: command.serverId,
        name: command.name,
        version: 1,
        generation: crypto.randomUUID(),
        high_water: 0,
        replay_floor: 0,
        search_policy: MESSAGE_SEARCH_POLICY,
      })
      .execute();
    await database
      .insertInto("members")
      .values({ user_id: command.ownerId, role: "owner" })
      .execute();
    await database
      .insertInto("channels")
      .values({
        id: command.serverId,
        name: firstChannelName,
        private: 0,
        version: 1,
      })
      .execute();
    await database
      .insertInto("server_initialization")
      .values({
        id: 1,
        name: command.name,
        owner_id: command.ownerId,
        first_channel_name: firstChannelName,
      })
      .execute();
    return {
      kind: "initialized",
      owner: { kind: "server", id: command.serverId },
      version: 1,
      channelId: command.serverId,
    };
  });
}
export async function createChannel(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: import("zod").input<typeof CreateChannelSchema>,
  budgetBytes: number,
): Promise<AdministrationOutcome> {
  const command = input;
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: state.version };
    const count = await database
      .selectFrom("channels")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    if (count.count >= 100) return { kind: "capacity" };
    if (
      await database
        .selectFrom("channels")
        .select("id")
        .where("id", "=", command.channelId)
        .executeTakeFirst()
    )
      return { kind: "command_conflict" };
    const full = await growthCapacityFailure(storage, database, budgetBytes);
    if (full) return full;
    const lastChannel = await database
      .selectFrom("channels")
      .select("position")
      .orderBy("position", "desc")
      .executeTakeFirst();
    await database
      .insertInto("channels")
      .values({
        id: command.channelId,
        name: command.name,
        private: Number(command.private),
        kind: command.kind ?? "text",
        version: 1,
        position: (lastChannel?.position ?? -1) + 1,
      })
      .execute();
    if (command.private)
      await database
        .insertInto("channel_members")
        .values({ channel_id: command.channelId, user_id: principal.userId })
        .execute();
    await database
      .updateTable("owner_state")
      .set({ version: state.version + 1 })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: state.version + 1 };
  });
}
export async function changeChannelMember(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: import("zod").infer<typeof ChangeChannelMemberSchema>,
): Promise<AdministrationOutcome> {
  const command = input;
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const channel = await database
      .selectFrom("channels")
      .selectAll()
      .where("id", "=", command.channelId)
      .executeTakeFirst();
    if (!channel) return { kind: "not_found" };
    if (channel.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: channel.version };
    if (channel.private === 0 || !(await membership(database, command.userId)))
      return { kind: "invalid_input" };
    if (command.allowed)
      await database
        .insertInto("channel_members")
        .values({ channel_id: command.channelId, user_id: command.userId })
        .onConflict((conflict) =>
          conflict.columns(["channel_id", "user_id"]).doNothing(),
        )
        .execute();
    else
      await database
        .deleteFrom("channel_members")
        .where("channel_id", "=", command.channelId)
        .where("user_id", "=", command.userId)
        .execute();
    await database
      .updateTable("channels")
      .set({ version: channel.version + 1 })
      .where("id", "=", command.channelId)
      .execute();
    const { state } = authorized;
    const cleanupPending =
      channel.kind === "media" && !command.allowed
        ? await queueMediaInvalidations(
            storage,
            database,
            [channel.id],
            command.userId,
            state.permission_version + 1,
          )
        : false;
    await database
      .updateTable("owner_state")
      .set({
        version: state.version + 1,
        permission_version: state.permission_version + 1,
      })
      .where("id", "=", 1)
      .execute();
    return {
      kind: "changed",
      version: channel.version + 1,
      ...(cleanupPending ? { mediaCleanup: "pending" as const } : {}),
    };
  });
}
export async function removeMember(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: import("zod").infer<typeof RemoveMemberSchema>,
): Promise<AdministrationOutcome> {
  const command = input;
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: state.version };
    const member = await membership(database, command.userId);
    if (!member) return { kind: "not_found" };
    if (member.role === "owner") return { kind: "forbidden" };
    const affectedRooms = await database
      .selectFrom("channels")
      .select("id")
      .where("kind", "=", "media")
      .where((eb) => visibleChannels(eb, command.userId))
      .limit(100)
      .execute();
    await database
      .deleteFrom("members")
      .where("user_id", "=", command.userId)
      .execute();
    await database
      .deleteFrom("channel_members")
      .where("user_id", "=", command.userId)
      .execute();
    await database
      .deleteFrom("socket_tickets")
      .where("user_id", "=", command.userId)
      .execute();
    const cleanupPending = await queueMediaInvalidations(
      storage,
      database,
      affectedRooms.map((room) => room.id),
      command.userId,
      state.permission_version + 1,
    );
    await database
      .updateTable("owner_state")
      .set({
        version: state.version + 1,
        permission_version: state.permission_version + 1,
      })
      .where("id", "=", 1)
      .execute();
    return {
      kind: "changed",
      version: state.version + 1,
      ...(cleanupPending ? { mediaCleanup: "pending" as const } : {}),
    };
  });
}
