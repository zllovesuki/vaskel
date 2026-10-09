import {
  AccountPreferencesSchema,
  type AccountPreferences,
  type UiLanguage,
  type UpdateAccountPreferencesResponse,
} from "@vaskel/contracts/preferences";
import type { Principal } from "@/server/domain/principal";
import type { AuthEnvironment } from "./environment";
import { identityDatabase } from "./database";
import { createD1Database } from "@/server/storage/d1-database";

/** Profile-only primary read; message authentication does not load preferences. */
export async function readAccountPreferences(
  env: AuthEnvironment,
  userId: string,
): Promise<AccountPreferences> {
  const row = await identityDatabase(env)
    .selectFrom("identity_preferences")
    .select(["language", "revision"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return AccountPreferencesSchema.parse(row ?? { language: null, revision: 0 });
}

export async function updateAccountPreferences(
  principal: Principal,
  language: UiLanguage,
  session: D1DatabaseSession,
): Promise<UpdateAccountPreferencesResponse> {
  // The session/epoch predicate is part of the same atomic statement as both
  // insert and update. A previously resolved principal alone cannot authorize it.
  const db = createD1Database(session);
  const row = await db
    .insertInto("identity_preferences")
    .columns(["user_id", "language", "revision"])
    .expression(
      db
        .selectFrom("identity_session as s")
        .innerJoin("identity_user as u", "u.id", "s.userId")
        .select((eb) => [
          "u.id as user_id",
          eb.val(language).as("language"),
          eb.lit(1).as("revision"),
        ])
        .where("s.id", "=", principal.sessionId)
        .where("u.id", "=", principal.userId)
        .whereRef("s.authEpoch", "=", "u.authEpoch")
        .where("u.emailVerified", "=", 1)
        .where("s.expiresAt", ">", new Date().toISOString()),
    )
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet((eb) => ({
        language: eb.ref("excluded.language"),
        revision: eb("identity_preferences.revision", "+", 1),
      })),
    )
    .returning(["language", "revision"])
    .executeTakeFirst();
  return row
    ? {
        kind: "preferences_updated",
        preferences: AccountPreferencesSchema.parse(row),
      }
    : { kind: "unauthenticated" };
}
