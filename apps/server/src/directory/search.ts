import { sql } from "kysely";
import { CROSS_SEARCH_MAX_CANDIDATES } from "@vaskel/contracts/search";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { directoryDatabase } from "./database";
import { knownOwner } from "./owners";

/** Directory rows nominate owners; only each owner's native read grants access. */
export async function searchOwnerCandidates(
  env: Env,
  principal: IdentityPrincipal,
  serverId: string | undefined,
  session: D1DatabaseSession,
): Promise<{ serverIds: string[]; limited: boolean }> {
  if (serverId) {
    const owner = await knownOwner(env, "server", serverId, session);
    return { serverIds: owner ? [serverId] : [], limited: false };
  }
  const rows = await directoryDatabase(env, session)
    .selectFrom("resource_membership_index as membership")
    .innerJoin(
      "resource_directory as resource",
      "resource.id",
      "membership.resource_id",
    )
    .select("resource.id")
    .where("membership.user_id", "=", principal.userId)
    .where("resource.kind", "=", "server")
    .where("resource.lifecycle", "=", "ready")
    .orderBy(sql<string>`resource.id COLLATE BINARY`)
    .limit(CROSS_SEARCH_MAX_CANDIDATES + 1)
    .execute();
  return {
    serverIds: rows.slice(0, CROSS_SEARCH_MAX_CANDIDATES).map((row) => row.id),
    limited: rows.length > CROSS_SEARCH_MAX_CANDIDATES,
  };
}
