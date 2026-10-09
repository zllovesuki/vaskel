import { constantTimeEqual, hashPassword } from "better-auth/crypto";
import type {
  BootstrapRequest,
  RegisterAccountRequest,
  RegisterAccountResponse,
} from "@vaskel/contracts/identity";
import { instanceLimit } from "@/server/domain/instance-limits";
import { identityDatabase, identitySession } from "./database";
import {
  expressionBuilder,
  type Expression,
  type InferResult,
  type SqlBool,
} from "kysely";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";
import type { IdentityDatabase } from "@/server/storage/identity-schema";
import type { AuthEnvironment } from "./environment";
import { authConfigured } from "./environment";
import { privateFingerprint } from "./crypto";
import {
  configuredMailer,
  deliverIdentityMail,
  preparedMailStatements,
  prepareIdentityMail,
} from "./mail";
import type { MailDependencies, PreparedIdentityMail } from "./mail";

/** This authorization is supplied only after the owning ServerDO reserves an invite. */
export interface AccountRegistrationAuthorization {
  authorizationId: string;
  userId: string;
}

const eb = expressionBuilder<IdentityDatabase>();

function accountStatements(
  session: D1DatabaseSession,
  input: RegisterAccountRequest,
  userId: string,
  passwordHash: string,
  mail: PreparedIdentityMail,
  guard: Expression<SqlBool>,
): D1PreparedStatement[] {
  const db = createD1Database(session);
  const timestamp = new Date(mail.createdAt).toISOString();
  const queries = [
    db
      .insertInto("identity_user")
      .columns([
        "id",
        "name",
        "email",
        "emailVerified",
        "createdAt",
        "updatedAt",
      ])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(userId).as("id"),
            eb.val(input.displayName).as("name"),
            eb.val(input.email).as("email"),
            eb.lit(0).as("emailVerified"),
            eb.val(timestamp).as("createdAt"),
            eb.val(timestamp).as("updatedAt"),
          ])
          .where(guard),
      )
      .compile(),
    db
      .insertInto("identity_account")
      .columns([
        "id",
        "userId",
        "accountId",
        "providerId",
        "password",
        "createdAt",
        "updatedAt",
      ])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(crypto.randomUUID()).as("id"),
            eb.val(userId).as("userId"),
            eb.val(userId).as("accountId"),
            eb.val("credential").as("providerId"),
            eb.val(passwordHash).as("password"),
            eb.val(timestamp).as("createdAt"),
            eb.val(timestamp).as("updatedAt"),
          ])
          .where(guard),
      )
      .compile(),
  ];
  return [
    ...queries.map((query) => prepareD1Query(session, query)),
    ...preparedMailStatements(session, mail, guard),
  ];
}

export async function getBootstrapStatus(
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): Promise<{ status: "available" | "complete" | "unavailable" }> {
  if (!authConfigured(env)) return { status: "unavailable" };
  const row = await identityDatabase(env)
    .selectFrom("identity_operator")
    .select("user_id")
    .where("singleton", "=", 1)
    .executeTakeFirst();
  if (row) return { status: "complete" };
  const configured =
    configuredMailer(env, dependencies) !== null &&
    /^[A-Za-z0-9_-]{43,128}$/.test(env.OPERATOR_BOOTSTRAP_SECRET) &&
    Date.parse(env.OPERATOR_BOOTSTRAP_EXPIRES_AT) > Date.now();
  return { status: configured ? "available" : "unavailable" };
}

export async function bootstrapOperator(
  input: BootstrapRequest,
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): Promise<RegisterAccountResponse> {
  if (
    !authConfigured(env) ||
    !configuredMailer(env, dependencies) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(env.OPERATOR_BOOTSTRAP_SECRET)
  )
    return { status: "unavailable" };
  if (!constantTimeEqual(input.bootstrapSecret, env.OPERATOR_BOOTSTRAP_SECRET))
    return { status: "forbidden" };
  if (!(Date.parse(env.OPERATOR_BOOTSTRAP_EXPIRES_AT) > Date.now()))
    return { status: "bootstrap_expired" };
  const session = identitySession(env);
  const db = createD1Database(session);
  if (
    await db
      .selectFrom("identity_operator")
      .select("singleton")
      .where("singleton", "=", 1)
      .executeTakeFirst()
  )
    return { status: "bootstrap_complete" };
  const accountLimit = instanceLimit(
    "INSTANCE_ACCOUNT_LIMIT",
    env.INSTANCE_ACCOUNT_LIMIT,
  );
  const userId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  const mail = await prepareIdentityMail(
    env,
    userId,
    input.email,
    "verify_email",
  );
  const users = db
    .selectFrom("identity_user")
    .select((eb) => eb.fn.countAll<number>().as("count"));
  const operator = db
    .selectFrom("identity_operator")
    .select("singleton")
    .where("singleton", "=", 1);
  const email = db
    .selectFrom("identity_user")
    .select("id")
    .where("email", "=", input.email);
  const claim = db
    .insertInto("identity_operator")
    .columns(["singleton", "user_id", "operation_id", "created_at"])
    .expression(
      db
        .selectNoFrom((eb) => [
          eb.lit(1).as("singleton"),
          eb.val(userId).as("user_id"),
          eb.val(operationId).as("operation_id"),
          eb.val(mail.createdAt).as("created_at"),
        ])
        .where(eb.not(eb.exists(email)))
        .where(eb.not(eb.exists(operator)))
        .where(
          eb(
            eb.val(Date.parse(env.OPERATOR_BOOTSTRAP_EXPIRES_AT)),
            ">",
            Date.now(),
          ),
        )
        .where(eb(users, "<", accountLimit)),
    )
    .onConflict((oc) => oc.column("singleton").doNothing());
  const admission = db.selectNoFrom([
    eb.exists(operator).as("operator_exists"),
    eb.exists(email).as("account_exists"),
    eb(users, ">=", accountLimit).as("at_capacity"),
  ]);
  const result = await session.batch<InferResult<typeof admission>[number]>([
    prepareD1Query(session, claim.compile()),
    ...accountStatements(
      session,
      input,
      userId,
      passwordHash,
      mail,
      eb.exists(
        db
          .selectFrom("identity_operator")
          .select("operation_id")
          .where("operation_id", "=", operationId),
      ),
    ),
    prepareD1Query(session, admission.compile()),
  ]);
  if (result[0]?.meta.changes !== 1) {
    // Classification belongs to the same primary commit as the guarded claim.
    const admission = result.at(-1)?.results[0];
    if (admission?.operator_exists === 1)
      return { status: "bootstrap_complete" };
    if (!(Date.parse(env.OPERATOR_BOOTSTRAP_EXPIRES_AT) > Date.now()))
      return { status: "bootstrap_expired" };
    if (admission?.account_exists === 1) return { status: "email_taken" };
    if (admission?.at_capacity === 1) return { status: "instance_capacity" };
    throw new Error("Operator admission did not produce a receipt.");
  }
  return {
    status: "registered",
    userId,
    mailDelivery: await deliverIdentityMail(env, mail.mailId, dependencies),
  };
}

function registrationFingerprint(
  input: RegisterAccountRequest,
  env: AuthEnvironment,
) {
  return privateFingerprint(
    env.AUTH_SECRET,
    JSON.stringify({
      email: input.email,
      password: input.password,
      displayName: input.displayName,
    }),
  );
}

/** Recover an exact accepted command without granting any new registration authority. */
export async function recoverRegisteredAccount(
  input: RegisterAccountRequest,
  authorization: AccountRegistrationAuthorization,
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): Promise<RegisterAccountResponse | null> {
  if (!authConfigured(env) || !configuredMailer(env, dependencies))
    return { status: "unavailable" };
  const db = identityDatabase(env);
  const { userId, authorizationId } = authorization;
  const payloadHash = await registrationFingerprint(input, env);
  const existing = await db
    .selectFrom("identity_registration")
    .select(["user_id", "email", "payload_hash"])
    .where("authorization_id", "=", authorizationId)
    .executeTakeFirst();
  if (existing) {
    if (
      existing.user_id !== userId ||
      existing.email !== input.email ||
      !constantTimeEqual(existing.payload_hash, payloadHash)
    )
      return { status: "authorization_conflict" };
    const mail = await db
      .selectFrom("identity_mail")
      .select("id")
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return {
      status: "registered",
      userId,
      mailDelivery: mail
        ? await deliverIdentityMail(env, mail.id, dependencies)
        : "pending",
    };
  }
  return null;
}

export async function registerAuthorizedAccount(
  input: RegisterAccountRequest,
  authorization: AccountRegistrationAuthorization,
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): Promise<RegisterAccountResponse> {
  const recovered = await recoverRegisteredAccount(
    input,
    authorization,
    env,
    dependencies,
  );
  if (recovered) return recovered;
  const session = identitySession(env);
  const db = createD1Database(session);
  const { userId, authorizationId } = authorization;
  const payloadHash = await registrationFingerprint(input, env);
  const accountLimit = instanceLimit(
    "INSTANCE_ACCOUNT_LIMIT",
    env.INSTANCE_ACCOUNT_LIMIT,
  );
  const operationId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  const mail = await prepareIdentityMail(
    env,
    userId,
    input.email,
    "verify_email",
  );
  const users = db
    .selectFrom("identity_user")
    .select((eb) => eb.fn.countAll<number>().as("count"));
  const account = db
    .selectFrom("identity_user")
    .select("id")
    .where((eb) =>
      eb.or([eb("email", "=", input.email), eb("id", "=", userId)]),
    );
  const registration = db
    .selectFrom("identity_registration")
    .select("user_id")
    .where("user_id", "=", userId);
  const claim = db
    .insertInto("identity_registration")
    .columns([
      "authorization_id",
      "user_id",
      "email",
      "payload_hash",
      "operation_id",
      "created_at",
    ])
    .expression(
      db
        .selectNoFrom((eb) => [
          eb.val(authorizationId).as("authorization_id"),
          eb.val(userId).as("user_id"),
          eb.val(input.email).as("email"),
          eb.val(payloadHash).as("payload_hash"),
          eb.val(operationId).as("operation_id"),
          eb.val(mail.createdAt).as("created_at"),
        ])
        .where(eb.not(eb.exists(account)))
        .where(eb.not(eb.exists(registration)))
        .where(eb(users, "<", accountLimit)),
    )
    .onConflict((oc) => oc.column("authorization_id").doNothing());
  const admission = db
    .selectFrom(db.selectNoFrom(eb.lit(1).as("present")).as("singleton"))
    .leftJoin("identity_registration as r", (join) =>
      join.on("r.authorization_id", "=", authorizationId),
    )
    .select(["r.user_id", "r.email", "r.payload_hash"])
    .select([
      eb.or([eb.exists(account), eb.exists(registration)]).as("account_exists"),
      eb(users, ">=", accountLimit).as("at_capacity"),
    ]);
  const result = await session.batch<InferResult<typeof admission>[number]>([
    prepareD1Query(session, claim.compile()),
    ...accountStatements(
      session,
      input,
      userId,
      passwordHash,
      mail,
      eb.exists(
        db
          .selectFrom("identity_registration")
          .select("operation_id")
          .where("operation_id", "=", operationId),
      ),
    ),
    prepareD1Query(session, admission.compile()),
  ]);
  if (result[0]?.meta.changes !== 1) {
    const receipt = result.at(-1)?.results[0];
    if (
      receipt &&
      receipt.user_id === userId &&
      receipt.email === input.email &&
      receipt.payload_hash !== null &&
      constantTimeEqual(receipt.payload_hash, payloadHash)
    ) {
      const delivered = await identityDatabase(env)
        .selectFrom("identity_mail")
        .select("id")
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return {
        status: "registered",
        userId,
        mailDelivery: delivered
          ? await deliverIdentityMail(env, delivered.id, dependencies)
          : "pending",
      };
    }
    if (receipt?.user_id) return { status: "authorization_conflict" };
    if (receipt?.account_exists === 1) return { status: "email_taken" };
    if (receipt?.at_capacity === 1) return { status: "instance_capacity" };
    throw new Error("Account admission did not produce a receipt.");
  }
  return {
    status: "registered",
    userId,
    mailDelivery: await deliverIdentityMail(env, mail.mailId, dependencies),
  };
}
