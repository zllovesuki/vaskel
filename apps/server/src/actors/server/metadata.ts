import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { z } from "zod";
import type {
  AdministrationOutcome,
  RenameServerSchema,
  UpdateChannelSchema,
  ReorderChannelsSchema,
  ServerAdministrationOutcome,
} from "@vaskel/contracts/administration";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { ownerAccess } from "@/server/actors/shared/policy";

export function administration(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
): Promise<ServerAdministrationOutcome> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.owner_kind !== "server") return { kind: "forbidden" };
    const channels = await database
      .selectFrom("channels")
      .select(["id", "name", "private", "kind", "version", "topic", "position"])
      .orderBy("position")
      .orderBy(sql`rowid`)
      .limit(100)
      .execute();
    return {
      kind: "administration",
      owner: { kind: "server", id: state.owner_id },
      name: state.name,
      version: state.version,
      membersMayInvite: state.members_may_invite !== 0,
      channels: channels.map((channel) => ({
        ...channel,
        private: channel.private !== 0,
      })),
    };
  });
}

/** Ordering is one owner mutation, including rooms the owner cannot read. */
export function reorderChannels(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: z.infer<typeof ReorderChannelsSchema>,
): Promise<AdministrationOutcome> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: state.version };
    const channels = await database
      .selectFrom("channels")
      .select(["id", "version", "position"])
      .execute();
    const requested = new Set(command.channelIds);
    if (
      requested.size !== command.channelIds.length ||
      channels.length !== requested.size ||
      channels.some((channel) => !requested.has(channel.id))
    )
      return { kind: "invalid_input" };
    const current = new Map(channels.map((channel) => [channel.id, channel]));
    for (const [position, id] of command.channelIds.entries()) {
      const channel = current.get(id)!;
      if (channel.position === position) continue;
      await database
        .updateTable("channels")
        .set({ position, version: channel.version + 1 })
        .where("id", "=", id)
        .execute();
    }
    await database
      .updateTable("owner_state")
      .set({ version: state.version + 1 })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: state.version + 1 };
  });
}

export function updateChannel(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: z.infer<typeof UpdateChannelSchema>,
): Promise<AdministrationOutcome> {
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
    await database
      .updateTable("channels")
      .set({
        ...(command.name !== undefined ? { name: command.name } : {}),
        ...(command.topic !== undefined ? { topic: command.topic } : {}),
        ...(command.position !== undefined
          ? { position: command.position }
          : {}),
        version: channel.version + 1,
      })
      .where("id", "=", command.channelId)
      .execute();
    await database
      .updateTable("owner_state")
      .set({ version: authorized.state.version + 1 })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: channel.version + 1 };
  });
}

export function renameServer(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: z.infer<typeof RenameServerSchema>,
): Promise<AdministrationOutcome> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    if (authorized.state.version !== command.expectedVersion)
      return {
        kind: "stale_version",
        currentVersion: authorized.state.version,
      };
    await database
      .updateTable("owner_state")
      .set({ name: command.name, version: authorized.state.version + 1 })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: authorized.state.version + 1 };
  });
}
