import type { Kysely } from "kysely";
import type { MembersOutcome } from "@vaskel/contracts/resources";
import {
  PEOPLE_CANDIDATE_LIMIT,
  type SharedPeopleOutcome,
} from "@/server/domain/people";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { access, ownerScope, visibleChannels } from "./policy";

/** Search needs only the candidate intersection, never private-channel rosters. */
export async function sharedPeople(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  userIds: string[],
): Promise<SharedPeopleOutcome> {
  if (userIds.length > PEOPLE_CANDIDATE_LIMIT) return { kind: "invalid_input" };
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const candidates = [...new Set(userIds)]
      .filter((id) => id !== principal.userId)
      .sort();
    const shared: string[] = [];
    for (let offset = 0; offset < candidates.length; offset += 64) {
      const rows = await database
        .selectFrom("members")
        .select("user_id")
        .where("user_id", "in", candidates.slice(offset, offset + 64))
        .orderBy("user_id")
        .execute();
      shared.push(...rows.map((row) => row.user_id));
    }
    return { kind: "shared_people", userIds: shared };
  });
}

export async function members(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
): Promise<MembersOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const rows = await database
      .selectFrom("members")
      .select(["members.user_id as userId", "role"])
      .orderBy("members.user_id")
      .execute();
    let channels = database
      .selectFrom("channels")
      .select("id")
      .where("private", "=", 1);
    // Ownership permits private-channel administration, not content access.
    if (authorized.member.role !== "owner")
      channels = channels.where((eb) => visibleChannels(eb, principal.userId));
    const privateChannels = await channels.orderBy("id").execute();
    // One key-range read covers every authorized private roster; the rule for a
    // single channel's readers lives in `channelReaders`.
    const rosterRows =
      privateChannels.length === 0
        ? []
        : await database
            .selectFrom("channel_members")
            .innerJoin("members", "members.user_id", "channel_members.user_id")
            .select(["channel_members.channel_id", "channel_members.user_id"])
            .where(
              "channel_members.channel_id",
              "in",
              privateChannels.map((channel) => channel.id),
            )
            .orderBy("channel_members.user_id")
            .execute();
    const channelMembers = privateChannels.map((channel) => ({
      channelId: channel.id,
      userIds: rosterRows
        .filter((row) => row.channel_id === channel.id)
        .map((row) => row.user_id),
    }));
    return {
      kind: "members",
      owner: ownerScope(authorized.state),
      version: authorized.state.version,
      members: rows,
      channelMembers,
    };
  });
}
