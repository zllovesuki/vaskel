import type { Principal } from "@/server/domain/principal";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import type { AuthEnvironment } from "./environment";
import { authConfigured } from "./environment";
import { identityDatabase } from "./database";
import { createAuth } from "./library";

export interface IdentityPrincipal extends Principal {
  /** Start of the primary authority read; later dispatch cannot refresh it. */
  verifiedAt: number;
  authEpoch: number;
  isOperator: boolean;
  displayName: string;
  email: string;
}

export async function getPrincipal(
  request: Request,
  env: AuthEnvironment,
  options: { identityPrecondition?: boolean } = {},
): Promise<IdentityPrincipal | null> {
  if (!authConfigured(env)) return null;
  const auth = createAuth(env);
  const authenticated = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!authenticated) return null;
  // Cookie integrity is verified by Better Auth; this fresh join decides authority.
  // An epoch mismatch fences a signin that finishes after a password reset.
  const verifiedAt = Date.now();
  const row = await identityDatabase(env)
    .selectFrom("identity_session as s")
    .innerJoin("identity_user as u", "u.id", "s.userId")
    .select([
      "u.id",
      "u.name",
      "u.email",
      "s.id as session_id",
      "s.expiresAt",
      "u.authEpoch",
    ])
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom("identity_operator as o")
            .select("o.user_id")
            .where("o.singleton", "=", 1)
            .whereRef("o.user_id", "=", "u.id"),
        )
        .as("is_operator"),
    )
    .where("s.id", "=", authenticated.session.id)
    .where("s.token", "=", authenticated.session.token)
    .where("u.emailVerified", "=", 1)
    .whereRef("s.authEpoch", "=", "u.authEpoch")
    .where("s.expiresAt", ">", new Date().toISOString())
    .executeTakeFirst();
  if (!row) return null;
  const expiresAt = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const expectedAccount = request.headers.get(EXPECTED_ACCOUNT_HEADER);
  if (
    options.identityPrecondition !== false &&
    expectedAccount !== null &&
    expectedAccount !== row.id
  )
    return null;
  return {
    userId: row.id,
    sessionId: row.session_id,
    expiresAt,
    verifiedAt,
    authEpoch: row.authEpoch,
    displayName: row.name,
    email: row.email,
    isOperator: row.is_operator === 1,
  };
}
