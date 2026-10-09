import { expressionBuilder, sql } from "kysely";
import type { Principal } from "@/server/domain/principal";
import type { IdentityDatabase } from "@/server/storage/identity-schema";

const eb = expressionBuilder<IdentityDatabase>();

/** Evaluate at statement construction, after any preceding asynchronous work. */
function liveSession(principal: Principal, now: string) {
  return eb
    .selectFrom("identity_session as s")
    .innerJoin("identity_user as u", "u.id", "s.userId")
    .select("s.id")
    .where("s.id", "=", principal.sessionId)
    .where("u.id", "=", principal.userId)
    .whereRef("s.authEpoch", "=", "u.authEpoch")
    .where("u.emailVerified", "=", 1)
    .where("s.expiresAt", ">", now);
}

/** Embed in the D1 mutation itself; a prior Worker read is not the commit decision. */
export function liveIdentity(principal: Principal) {
  return eb.exists(liveSession(principal, new Date().toISOString()));
}

export function serverCreationPermission(userId: string) {
  return eb.or([
    eb.exists(
      eb
        .selectFrom("identity_operator")
        .select("user_id")
        .where("singleton", "=", 1)
        .where("user_id", "=", userId),
    ),
    eb.exists(
      eb
        .selectFrom("instance_capability")
        .select("user_id")
        .where("user_id", "=", userId)
        .where("create_servers", "=", 1),
    ),
  ]);
}

/** Operator authority additionally requires the singleton claim and database-clock expiry. */
export function liveOperator(principal: Principal) {
  return eb.exists(
    liveSession(principal, new Date(Date.now()).toISOString())
      .innerJoin("identity_operator as o", "o.user_id", "u.id")
      .where("o.singleton", "=", 1)
      .where(
        "s.expiresAt",
        ">",
        sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ),
  );
}
