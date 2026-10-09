import type { Kysely } from "kysely";
import {
  PRESENCE_MEMBER_PAGE_SIZE,
  type PresenceSelection,
  type PresenceCandidatesOutcome,
} from "@vaskel/contracts/presence";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import { access } from "./policy";

/** Authorization and candidate selection share the owning actor's native transaction. */
export async function presenceCandidates(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  selection: PresenceSelection = {},
): Promise<PresenceCandidatesOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    let query = database
      .selectFrom("members")
      .select("user_id")
      .orderBy("user_id")
      .limit(PRESENCE_MEMBER_PAGE_SIZE + 1);
    if ("userIds" in selection)
      query = query.where("user_id", "in", selection.userIds);
    else if (selection.after)
      query = query.where("user_id", ">", selection.after);
    const rows = await query.execute();
    const userIds = rows
      .slice(0, PRESENCE_MEMBER_PAGE_SIZE)
      .map((row) => row.user_id);
    return {
      kind: "presence_candidates",
      userIds,
      nextCursor:
        rows.length > PRESENCE_MEMBER_PAGE_SIZE ? userIds.at(-1)! : null,
    };
  });
}
