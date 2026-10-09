import { hashPassword } from "better-auth/crypto";
import { expressionBuilder, type InferResult } from "kysely";
import type { IdentityDatabase } from "@/server/storage/identity-schema";
import { identitySession } from "./database";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";
import type { AuthEnvironment } from "./environment";
import { revokeAccountEvents } from "./event-revocation";
import {
  configuredMailer,
  deliverIdentityMail,
  preparedMailStatements,
  prepareIdentityMail,
} from "./mail";
import type { IdentityTokenKind, MailDependencies } from "./mail";
import { sha256Hex } from "./crypto";
import { liveOperator } from "./sql-authority";
import type { Principal } from "@/server/domain/principal";

export async function requestIdentityEmail(
  email: string,
  kind: IdentityTokenKind,
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): Promise<{ status: "accepted" | "unavailable" | "invalid_request" }> {
  if (!configuredMailer(env, dependencies)) return { status: "unavailable" };
  const session = identitySession(env);
  const db = createD1Database(session);
  const user = await db
    .selectFrom("identity_user")
    .select(["id", "email", "emailVerified"])
    .where("email", "=", email)
    .executeTakeFirst();
  // Run the same encryption and conditional batch for absent/ineligible identities.
  // Delivery is deferred until after the HTTP response to limit timing disclosure.
  const userId = user?.id ?? crypto.randomUUID();
  const mail = await prepareIdentityMail(env, userId, email, kind);
  const guard = db
    .selectFrom("identity_user")
    .select("id")
    .where("id", "=", userId)
    .where((eb) =>
      eb.or([
        eb(eb.val(kind), "=", "reset_password"),
        eb("emailVerified", "=", 0),
      ]),
    );
  await session.batch(
    preparedMailStatements(
      session,
      mail,
      expressionBuilder<IdentityDatabase>().exists(guard),
    ),
  );
  return { status: "accepted" };
}

export async function verifyIdentityEmail(
  token: string,
  env: AuthEnvironment,
): Promise<{ status: "email_verified" | "invalid_token" }> {
  const session = identitySession(env);
  const db = createD1Database(session);
  const now = Date.now();
  const consumptionId = crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const queries = [
    db
      .updateTable("identity_token")
      .set({ consumed_at: now, consumption_id: consumptionId })
      .where("token_hash", "=", tokenHash)
      .where("kind", "=", "verify_email")
      .where("consumed_at", "is", null)
      .where("expires_at", ">", now)
      .compile(),
    db
      .updateTable("identity_user")
      .set({ emailVerified: 1, updatedAt: new Date(now).toISOString() })
      .where(
        "id",
        "=",
        db
          .selectFrom("identity_token")
          .select("user_id")
          .where("consumption_id", "=", consumptionId),
      )
      .compile(),
  ];
  const result = await session.batch(
    queries.map((query) => prepareD1Query(session, query)),
  );
  return {
    status: result[0]?.meta.changes === 1 ? "email_verified" : "invalid_token",
  };
}

export async function resetIdentityPassword(
  token: string,
  password: string,
  env: AuthEnvironment,
): Promise<{ status: "password_reset" | "invalid_token" | "invalid_request" }> {
  const passwordHash = await hashPassword(password);
  const session = identitySession(env);
  const db = createD1Database(session);
  const now = Date.now();
  const consumptionId = crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const consumedUser = db
    .selectFrom("identity_token")
    .select("user_id")
    .where("consumption_id", "=", consumptionId);
  const epoch = db
    .updateTable("identity_user")
    .set((eb) => ({
      authEpoch: eb("authEpoch", "+", 1),
      updatedAt: new Date(now).toISOString(),
    }))
    .where("id", "=", consumedUser)
    .returning(["id", "authEpoch"]);
  const queries = [
    db
      .updateTable("identity_token")
      .set({ consumed_at: now, consumption_id: consumptionId })
      .where("token_hash", "=", tokenHash)
      .where("kind", "=", "reset_password")
      .where("consumed_at", "is", null)
      .where("expires_at", ">", now)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("identity_account as a")
            .select("a.id")
            .whereRef("a.userId", "=", "identity_token.user_id")
            .whereRef("a.accountId", "=", "identity_token.user_id")
            .where("a.providerId", "=", "credential")
            .where("a.password", "is not", null),
        ),
      )
      .compile(),
    db
      .updateTable("identity_account")
      .set({ password: passwordHash, updatedAt: new Date(now).toISOString() })
      .where("providerId", "=", "credential")
      .where("userId", "=", consumedUser)
      .compile(),
    epoch.compile(),
    db
      .deleteFrom("identity_session")
      .where("userId", "=", consumedUser)
      .compile(),
    db
      .updateTable("identity_token")
      .set({ consumed_at: now })
      .where("kind", "=", "reset_password")
      .where("consumed_at", "is", null)
      .where("user_id", "=", consumedUser)
      .compile(),
  ];
  const result = await session.batch<InferResult<typeof epoch>[number]>(
    queries.map((query) => prepareD1Query(session, query)),
  );
  if (result[0]?.meta.changes === 1) {
    const changed = result[2]?.results[0];
    if (!changed) throw new Error("Password reset lost its account epoch.");
    await revokeAccountEvents(env, changed.id, {
      kind: "epoch",
      minimumAuthEpoch: changed.authEpoch,
    });
  }
  return {
    status: result[0]?.meta.changes === 1 ? "password_reset" : "invalid_token",
  };
}

export async function operatorRequestPasswordReset(
  principal: Principal,
  input: { userId: string; reason: string },
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): Promise<{
  status: "accepted" | "forbidden" | "unavailable" | "invalid_request";
}> {
  if (!configuredMailer(env, dependencies)) return { status: "unavailable" };
  const session = identitySession(env);
  const db = createD1Database(session);
  const actorUserId = principal.userId;
  const operator = await db
    .selectNoFrom((eb) => eb.lit(1).as("authorized"))
    .where(liveOperator(principal))
    .executeTakeFirst();
  if (!operator) return { status: "forbidden" };
  const target = await db
    .selectFrom("identity_user")
    .select(["id", "email"])
    .where("id", "=", input.userId)
    .executeTakeFirst();
  if (!target) return { status: "accepted" };
  const mail = await prepareIdentityMail(
    env,
    target.id,
    target.email,
    "reset_password",
  );
  // Authority is decided again at commit time; the read above is not the decision.
  const commitGuard = liveOperator(principal);
  const audit = db
    .insertInto("identity_audit")
    .columns([
      "id",
      "actor_user_id",
      "target_user_id",
      "action",
      "reason",
      "created_at",
    ])
    .expression(
      db
        .selectNoFrom((eb) => [
          eb.val(crypto.randomUUID()).as("id"),
          eb.val(actorUserId).as("actor_user_id"),
          eb.val(target.id).as("target_user_id"),
          eb.val("operator_password_reset_requested" as const).as("action"),
          eb.val(input.reason).as("reason"),
          eb.val(Date.now()).as("created_at"),
        ])
        .where(commitGuard),
    );
  const result = await session.batch([
    prepareD1Query(session, audit.compile()),
    ...preparedMailStatements(session, mail, commitGuard),
  ]);
  if (result[0]?.meta.changes !== 1) return { status: "forbidden" };
  await deliverIdentityMail(env, mail.mailId, dependencies);
  return { status: "accepted" };
}
