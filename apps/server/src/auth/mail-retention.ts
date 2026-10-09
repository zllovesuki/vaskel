import { createD1Database, prepareD1Query } from "@/server/storage/d1-database";

/** Completed delivery diagnostics are separate from message-content retention. */
export const IDENTITY_MAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_BATCH = 200;

/** These statements join the caller's native D1 batch; no external mail I/O. */
export function identityMailCleanup(session: D1DatabaseSession, now: number) {
  const db = createD1Database(session);
  const queries = [
    db
      .updateTable("identity_mail")
      .set({
        cancelled_at: now,
        payload_ciphertext: "",
        lease_id: null,
        lease_expires_at: null,
      })
      .where(
        "id",
        "in",
        db
          .selectFrom("identity_mail as mail")
          .innerJoin(
            "identity_token as token",
            "token.token_hash",
            "mail.token_hash",
          )
          .select("mail.id")
          .where("mail.delivered_at", "is", null)
          .where("mail.cancelled_at", "is", null)
          .where((eb) =>
            eb.or([
              eb("mail.lease_expires_at", "is", null),
              eb("mail.lease_expires_at", "<=", now),
            ]),
          )
          .where((eb) =>
            eb.or([
              eb("token.expires_at", "<=", now),
              eb("token.consumed_at", "is not", null),
            ]),
          )
          .orderBy("mail.next_attempt_at")
          .limit(CLEANUP_BATCH),
      )
      .compile(),
    db
      .deleteFrom("identity_mail")
      .where(
        "id",
        "in",
        db
          .selectFrom("identity_mail")
          .select("id")
          .where((eb) =>
            eb.or([
              eb("delivered_at", "is not", null),
              eb("cancelled_at", "is not", null),
            ]),
          )
          .where("lease_id", "is", null)
          .where("lease_expires_at", "is", null)
          .where((eb) =>
            eb(
              eb.fn.coalesce("delivered_at", "cancelled_at"),
              "<=",
              now - IDENTITY_MAIL_RETENTION_MS,
            ),
          )
          .orderBy((eb) => eb.fn.coalesce("delivered_at", "cancelled_at"))
          .orderBy("id")
          .limit(CLEANUP_BATCH),
      )
      .compile(),
    db
      .deleteFrom("identity_token")
      .where(
        "token_hash",
        "in",
        db
          .selectFrom("identity_token")
          .select("token_hash")
          .where("expires_at", "<", now - IDENTITY_MAIL_RETENTION_MS)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("identity_mail")
                  .select("id")
                  .whereRef(
                    "identity_mail.token_hash",
                    "=",
                    "identity_token.token_hash",
                  ),
              ),
            ),
          )
          .orderBy("expires_at")
          .orderBy("token_hash")
          .limit(CLEANUP_BATCH),
      )
      .compile(),
  ];
  return queries.map((query) => prepareD1Query(session, query));
}
