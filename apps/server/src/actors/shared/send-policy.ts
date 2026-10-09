import type { Kysely } from "kysely";
import type { OwnerDatabase, OwnerState } from "./database";

/** New direct content only. Read/edit/delete access and accepted send receipts are separate. */
export async function newSendFailure(
  database: Kysely<OwnerDatabase>,
  state: OwnerState,
): Promise<{ kind: "dm_blocked" } | null> {
  if (state.owner_kind !== "conversation") return null;
  const blocked = await database
    .selectFrom("direct_blocks")
    .select("user_id")
    .where("blocked", "=", 1)
    .limit(1)
    .executeTakeFirst();
  return blocked ? { kind: "dm_blocked" } : null;
}
