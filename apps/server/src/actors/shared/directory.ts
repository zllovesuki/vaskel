import { directoryOccupancy } from "./occupancy";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DirectoryOutcome } from "@vaskel/contracts/resources";
import type { Principal } from "@/server/domain/principal";
import type { InvitePolicy } from "@vaskel/contracts/instance";
import type { OwnerDatabase } from "./database";
import { access, ownerScope, visibleChannels } from "./policy";
import { newSendFailure } from "./send-policy";

export async function directory(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  invitePolicy: InvitePolicy = "owners",
): Promise<DirectoryOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state, member } = authorized;
    const participantIds =
      state.owner_kind === "conversation"
        ? (
            await database
              .selectFrom("members")
              .select("user_id")
              .orderBy("user_id")
              .execute()
          ).map((row) => row.user_id)
        : undefined;
    const channels = await database
      .selectFrom("channels")
      .leftJoin(
        "channel_occupancy",
        "channel_occupancy.channel_id",
        "channels.id",
      )
      .selectAll("channels")
      .select([
        "channel_occupancy.summary as occupancySummary",
        "channel_occupancy.revision as occupancyRevision",
      ])
      .where((eb) => visibleChannels(eb, principal.userId))
      .orderBy("position")
      .orderBy(sql`channels.rowid`)
      .limit(100)
      .execute();
    const occupancy = await directoryOccupancy(database, channels);
    return {
      kind: "directory",
      owner: ownerScope(state),
      name: state.name,
      version: state.version,
      role: member.role,
      canSend: (await newSendFailure(database, state)) === null,
      ...(participantIds ? { participantIds } : {}),
      ...(state.owner_kind === "server"
        ? {
            membersMayInvite: state.members_may_invite !== 0,
            canCreateInvite:
              member.role === "owner" ||
              (state.members_may_invite !== 0 && invitePolicy === "members"),
          }
        : {}),
      channels: channels.map((channel) => ({
        occupancy: occupancy.get(channel.id) ?? null,
        id: channel.id,
        name: channel.name,
        private: channel.private !== 0,
        kind: channel.kind,
        version: channel.version,
        topic: channel.topic,
        position: channel.position,
      })),
    };
  });
}
