import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import { identityDatabase, identitySession } from "./database";
import type { Expression, SqlBool } from "kysely";
import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";
import type { AuthEnvironment } from "./environment";
import { authConfigured, authOrigin } from "./environment";
import { randomIdentityToken, sha256Hex } from "./crypto";
import { identityMailCleanup } from "./mail-retention";
import { logEvent } from "@/server/telemetry";

const MailPayloadSchema = z.strictObject({
  to: z.email(),
  subject: z.string(),
  text: z.string(),
});
export type IdentityMail = z.infer<typeof MailPayloadSchema>;
export interface IdentityMailer {
  send(message: IdentityMail): Promise<void>;
}
export interface MailDependencies {
  mailer?: IdentityMailer;
}
export type IdentityTokenKind = "verify_email" | "reset_password";

export function configuredMailer(
  env: AuthEnvironment,
  dependencies: MailDependencies = {},
): IdentityMailer | null {
  if (!authConfigured(env)) return null;
  if (dependencies.mailer) return dependencies.mailer;
  if (
    typeof env.EMAIL?.send !== "function" ||
    !z.email().safeParse(env.MAIL_FROM).success
  )
    return null;
  return {
    send: async (message) => {
      await env.EMAIL.send({ from: env.MAIL_FROM, ...message });
    },
  };
}

export interface PreparedIdentityMail {
  tokenHash: string;
  userId: string;
  kind: IdentityTokenKind;
  expiresAt: number;
  createdAt: number;
  mailId: string;
  ciphertext: string;
}

export async function prepareIdentityMail(
  env: AuthEnvironment,
  userId: string,
  email: string,
  kind: IdentityTokenKind,
): Promise<PreparedIdentityMail> {
  const token = randomIdentityToken();
  const createdAt = Date.now();
  const url = new URL(
    kind === "verify_email" ? "/verify-email" : "/reset-password",
    authOrigin(env) ?? undefined,
  );
  url.searchParams.set("token", token);
  const message: IdentityMail = {
    to: email,
    subject:
      kind === "verify_email"
        ? "Verify your vaskel. email"
        : "Reset your vaskel. password",
    text: `${kind === "verify_email" ? "Verify your email address" : "Reset your password"}: ${url.href}\n\nThis link expires in ${kind === "verify_email" ? "60" : "30"} minutes and can be used once. If you did not request it, you can ignore this email.`,
  };
  return {
    tokenHash: await sha256Hex(token),
    userId,
    kind,
    createdAt,
    expiresAt: createdAt + (kind === "verify_email" ? 60 : 30) * 60_000,
    mailId: crypto.randomUUID(),
    ciphertext: await symmetricEncrypt({
      key: env.AUTH_SECRET,
      data: JSON.stringify(message),
    }),
  };
}

/** The bound authority predicate joins the caller's native D1 batch. */
export function preparedMailStatements(
  session: D1DatabaseSession,
  mail: PreparedIdentityMail,
  guard: Expression<SqlBool>,
): D1PreparedStatement[] {
  const db = createD1Database(session);
  const queries = [
    db
      .updateTable("identity_token")
      .set({ consumed_at: mail.createdAt })
      .where("user_id", "=", mail.userId)
      .where("kind", "=", mail.kind)
      .where("consumed_at", "is", null)
      .where(guard)
      .compile(),
    db
      .insertInto("identity_token")
      .columns(["token_hash", "user_id", "kind", "expires_at", "created_at"])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(mail.tokenHash).as("token_hash"),
            eb.val(mail.userId).as("user_id"),
            eb.val(mail.kind).as("kind"),
            eb.val(mail.expiresAt).as("expires_at"),
            eb.val(mail.createdAt).as("created_at"),
          ])
          .where(guard),
      )
      .compile(),
    db
      .insertInto("identity_mail")
      .columns([
        "id",
        "user_id",
        "token_hash",
        "payload_ciphertext",
        "created_at",
        "next_attempt_at",
      ])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(mail.mailId).as("id"),
            eb.val(mail.userId).as("user_id"),
            eb.val(mail.tokenHash).as("token_hash"),
            eb.val(mail.ciphertext).as("payload_ciphertext"),
            eb.val(mail.createdAt).as("created_at"),
            eb.val(mail.createdAt).as("next_attempt_at"),
          ])
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("identity_token")
                .select("token_hash")
                .where("token_hash", "=", mail.tokenHash),
            ),
          ),
      )
      .compile(),
  ];
  return queries.map((query) => prepareD1Query(session, query));
}

export async function deliverIdentityMail(
  env: AuthEnvironment,
  id: string,
  dependencies: MailDependencies = {},
): Promise<"sent" | "pending"> {
  const mailer = configuredMailer(env, dependencies);
  if (!mailer) return "pending";
  const db = identityDatabase(env);
  const now = Date.now();
  const leaseId = crypto.randomUUID();
  const row = await db
    .updateTable("identity_mail")
    .set((eb) => ({
      lease_id: leaseId,
      lease_expires_at: now + 30_000,
      attempts: eb("attempts", "+", 1),
    }))
    .where("id", "=", id)
    .where("delivered_at", "is", null)
    .where("cancelled_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("lease_expires_at", "is", null),
        eb("lease_expires_at", "<=", now),
      ]),
    )
    .returning(["payload_ciphertext", "token_hash", "attempts"])
    .executeTakeFirst();
  if (!row) {
    const existing = await db
      .selectFrom("identity_mail")
      .select("delivered_at")
      .where("id", "=", id)
      .executeTakeFirst();
    return existing?.delivered_at !== null &&
      existing?.delivered_at !== undefined
      ? "sent"
      : "pending";
  }
  const token = await db
    .selectFrom("identity_token")
    .select(["expires_at", "consumed_at"])
    .where("token_hash", "=", row.token_hash)
    .executeTakeFirst();
  const checkedAt = Date.now();
  if (!token || token.expires_at <= checkedAt || token.consumed_at !== null) {
    await db
      .updateTable("identity_mail")
      .set({
        cancelled_at: checkedAt,
        payload_ciphertext: "",
        lease_id: null,
        lease_expires_at: null,
      })
      .where("id", "=", id)
      .where("lease_id", "=", leaseId)
      .execute();
    return "pending";
  }
  try {
    const message = MailPayloadSchema.parse(
      JSON.parse(
        await symmetricDecrypt({
          key: env.AUTH_SECRET,
          data: row.payload_ciphertext,
        }),
      ),
    );
    await mailer.send(message);
  } catch (error) {
    logEvent("warn", "identity_mail_delivery_failed", {}, error);
    await db
      .updateTable("identity_mail")
      .set({
        next_attempt_at:
          Date.now() +
          Math.min(3_600_000, 5_000 * 2 ** Math.min(row.attempts, 10)),
        lease_id: null,
        lease_expires_at: null,
      })
      .where("id", "=", id)
      .where("lease_id", "=", leaseId)
      .execute();
    return "pending";
  }
  await db
    .updateTable("identity_mail")
    .set({
      delivered_at: Date.now(),
      payload_ciphertext: "",
      lease_id: null,
      lease_expires_at: null,
    })
    .where("id", "=", id)
    .where("lease_id", "=", leaseId)
    .execute();
  return "sent";
}

export async function retryIdentityMail(
  env: AuthEnvironment,
  options: { limit?: number } = {},
  dependencies: MailDependencies = {},
): Promise<{ sent: number; pending: number }> {
  const limit = Math.min(25, Math.max(1, options.limit ?? 10));
  const session = identitySession(env);
  const db = createD1Database(session);
  const now = Date.now();
  const rows = await db
    .selectFrom("identity_mail")
    .select("id")
    .where("delivered_at", "is", null)
    .where("cancelled_at", "is", null)
    .where("next_attempt_at", "<=", now)
    .where((eb) =>
      eb.or([
        eb("lease_expires_at", "is", null),
        eb("lease_expires_at", "<=", now),
      ]),
    )
    .orderBy("next_attempt_at")
    .limit(limit)
    .execute();
  const counts = { sent: 0, pending: 0 };
  for (const row of rows)
    counts[await deliverIdentityMail(env, row.id, dependencies)] += 1;
  await session.batch([
    ...identityMailCleanup(session, now),
    prepareD1Query(
      session,
      db
        .deleteFrom("identity_session")
        .where((eb) =>
          eb.or([
            eb("expiresAt", "<=", new Date(now).toISOString()),
            eb(
              "authEpoch",
              "!=",
              eb
                .selectFrom("identity_user")
                .select("authEpoch")
                .whereRef("id", "=", "identity_session.userId"),
            ),
          ]),
        )
        .compile(),
    ),
  ]);
  logEvent(counts.pending ? "warn" : "log", "identity_mail_retry", {
    processed: rows.length,
    sent: counts.sent,
    pending: counts.pending,
    durationMs: Date.now() - now,
  });
  return counts;
}
