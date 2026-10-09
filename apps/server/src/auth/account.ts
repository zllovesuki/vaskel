import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { InferResult } from "kysely";
import {
  userAgentFamily,
  type ChangePasswordRequest,
} from "@vaskel/contracts/account";
import type { Principal } from "@/server/domain/principal";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";
import type { AuthEnvironment } from "./environment";
import { identityDatabase, identitySession } from "./database";
import { revokeAccountEvents } from "./event-revocation";
import { liveIdentity } from "./sql-authority";

export async function updateIdentityProfile(
  principal: Principal,
  name: string,
  env: AuthEnvironment,
) {
  const guard = liveIdentity(principal);
  const result = await identityDatabase(env)
    .updateTable("identity_user")
    .set({ name, updatedAt: new Date().toISOString() })
    .where("id", "=", principal.userId)
    .where(guard)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n
    ? { status: "profile_updated" as const, displayName: name }
    : { status: "unauthenticated" as const };
}

export async function changeIdentityPassword(
  principal: Principal,
  input: ChangePasswordRequest,
  env: AuthEnvironment,
) {
  const session = identitySession(env);
  const db = createD1Database(session);
  const guard = liveIdentity(principal);
  const credential = await db
    .selectFrom("identity_account as a")
    .innerJoin("identity_user as u", "u.id", "a.userId")
    .select(["a.password", "u.authEpoch"])
    .where("a.userId", "=", principal.userId)
    .whereRef("a.accountId", "=", "a.userId")
    .where("a.providerId", "=", "credential")
    .where(guard)
    .executeTakeFirst();
  if (!credential) return { status: "unauthenticated" as const };
  if (
    !credential.password ||
    !(await verifyPassword({
      hash: credential.password,
      password: input.currentPassword,
    }))
  )
    return { status: "invalid_credentials" as const };
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date().toISOString();
  const commitGuard = liveIdentity(principal);
  // The freshly salted hash identifies this successful compare-and-swap inside
  // the native batch. No other statement may act after a failed credential CAS.
  const rotated = db
    .selectFrom("identity_account as a")
    .select("a.userId")
    .where("a.userId", "=", principal.userId)
    .whereRef("a.accountId", "=", "a.userId")
    .where("a.providerId", "=", "credential")
    .where("a.password", "=", passwordHash);
  const queries = [
    db
      .updateTable("identity_account")
      .set({ password: passwordHash, updatedAt: now })
      .where("userId", "=", principal.userId)
      .whereRef("accountId", "=", "userId")
      .where("providerId", "=", "credential")
      .where("password", "=", credential.password)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("identity_user")
            .select("id")
            .where("id", "=", principal.userId)
            .where("authEpoch", "=", credential.authEpoch),
        ),
      )
      .where(commitGuard)
      .compile(),
    db
      .updateTable("identity_user")
      .set((eb) => ({ authEpoch: eb("authEpoch", "+", 1), updatedAt: now }))
      .where("id", "=", principal.userId)
      .where((eb) => eb.exists(rotated))
      .compile(),
    // Only sessions valid at the instant of this batch are retained. An old
    // password signin completing later still carries the old epoch and fails.
    db
      .updateTable("identity_session")
      .set({ authEpoch: credential.authEpoch + 1 })
      .where("userId", "=", principal.userId)
      .where("authEpoch", "=", credential.authEpoch)
      .where((eb) =>
        eb.or([
          eb(eb.val(Number(input.revokeOtherSessions)), "=", 0),
          eb("id", "=", principal.sessionId),
        ]),
      )
      .where((eb) => eb.exists(rotated))
      .compile(),
    db
      .deleteFrom("identity_session")
      .where("userId", "=", principal.userId)
      .where("id", "!=", principal.sessionId)
      .where((eb) => eb(eb.val(Number(input.revokeOtherSessions)), "=", 1))
      .where((eb) => eb.exists(rotated))
      .compile(),
    db
      .updateTable("identity_token")
      .set({ consumed_at: Date.now() })
      .where("user_id", "=", principal.userId)
      .where("kind", "=", "reset_password")
      .where("consumed_at", "is", null)
      .where((eb) => eb.exists(rotated))
      .compile(),
  ];
  const result = await session.batch(
    queries.map((query) => prepareD1Query(session, query)),
  );
  if (result[0]?.meta.changes !== 1)
    return { status: "unauthenticated" as const };
  if (input.revokeOtherSessions) {
    // Preserve the current connection as well as its cookie. The epoch fence
    // still covers old-password signins completing after this batch.
    await revokeAccountEvents(env, principal.userId, {
      kind: "epoch",
      minimumAuthEpoch: credential.authEpoch + 1,
      preserveSessionId: principal.sessionId,
    });
  }
  return { status: "password_changed" as const };
}

export async function listIdentitySessions(
  principal: Principal,
  env: AuthEnvironment,
) {
  const session = identitySession(env);
  const db = createD1Database(session);
  const guard = liveIdentity(principal);
  // An authorization row distinguishes revocation from an empty list and shares
  // the same native batch snapshot as the bounded session read.
  const sessions = db
    .selectFrom("identity_session as s")
    .innerJoin("identity_user as u", "u.id", "s.userId")
    .select(["s.id", "s.createdAt", "s.userAgent"])
    .where("s.userId", "=", principal.userId)
    .whereRef("s.authEpoch", "=", "u.authEpoch")
    .where("s.expiresAt", ">", new Date().toISOString())
    .where(guard)
    .orderBy((eb) => eb("s.id", "=", principal.sessionId), "desc")
    .orderBy("s.createdAt", "desc")
    .orderBy("s.id")
    .limit(101);
  const queries = [
    db
      .selectNoFrom((eb) => eb.lit(1).as("authorized"))
      .where(guard)
      .compile(),
    sessions.compile(),
  ];
  const result = await session.batch<InferResult<typeof sessions>[number]>(
    queries.map((query) => prepareD1Query(session, query)),
  );
  if (!result[0]?.results.length) return { status: "unauthenticated" as const };
  const rows = result[1]?.results ?? [];
  return {
    status: "sessions" as const,
    sessions: rows.slice(0, 100).map((row) => ({
      id: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      userAgentFamily: userAgentFamily(row.userAgent),
      current: row.id === principal.sessionId,
    })),
    partial: rows.length > 100,
  };
}

export async function revokeIdentitySession(
  principal: Principal,
  sessionId: string,
  env: AuthEnvironment,
) {
  const guard = liveIdentity(principal);
  const result = await identityDatabase(env)
    .deleteFrom("identity_session")
    .where("id", "=", sessionId)
    .where("userId", "=", principal.userId)
    .where(guard)
    .returning("expiresAt")
    .executeTakeFirst();
  if (!result) return { status: "invalid_request" as const };
  await revokeAccountEvents(env, principal.userId, {
    kind: "session",
    sessionId,
    expiresAt: Date.parse(result.expiresAt),
  });
  return {
    status: "session_revoked" as const,
    current: sessionId === principal.sessionId,
  };
}
