import type { IdentityPrincipal } from "@/server/auth/principal";
import { liveOperator } from "@/server/auth/sql-authority";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";

/** Authority, capability mutation and audit share one identity-store transaction. */
export async function setServerCreationGrant(
  principal: IdentityPrincipal,
  userId: string,
  allowed: boolean,
  session: D1DatabaseSession,
) {
  const now = Date.now();
  const db = createD1Database(session);
  const authority = liveOperator(principal);
  const eligible = db
    .selectFrom("identity_user")
    .select("id")
    .where("id", "=", userId)
    .where("emailVerified", "=", 1);
  // Every predicate is evaluated inside the same native batch, including revocation.
  const queries = [
    db
      .insertInto("instance_capability")
      .columns(["user_id", "create_servers", "granted_by", "updated_at"])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(userId).as("user_id"),
            eb.val(allowed ? (1 as const) : (0 as const)).as("create_servers"),
            eb.val(principal.userId).as("granted_by"),
            eb.val(now).as("updated_at"),
          ])
          .where(authority)
          .where((eb) => eb.exists(eligible)),
      )
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet((eb) => ({
          create_servers: eb.ref("excluded.create_servers"),
          granted_by: eb.ref("excluded.granted_by"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .returning("user_id")
      .compile(),
    db
      .insertInto("directory_audit")
      .columns([
        "id",
        "actor_id",
        "target_id",
        "action",
        "allowed",
        "created_at",
      ])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(crypto.randomUUID()).as("id"),
            eb.val(principal.userId).as("actor_id"),
            eb.val(userId).as("target_id"),
            eb.val("server_creation_permission" as const).as("action"),
            eb.val(allowed ? (1 as const) : (0 as const)).as("allowed"),
            eb.val(now).as("created_at"),
          ])
          .where(authority)
          .where((eb) => eb.exists(eligible)),
      )
      .compile(),
  ];
  const result = await session.batch(
    queries.map((query) => prepareD1Query(session, query)),
  );
  return result[0]?.results.length
    ? { kind: "granted" as const }
    : { kind: "forbidden" as const };
}
