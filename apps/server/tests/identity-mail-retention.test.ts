import { describe, expect, it } from "vitest";
import { deliverIdentityMail, retryIdentityMail } from "@/server/auth/mail";
import { IDENTITY_MAIL_RETENTION_MS } from "@/server/auth/mail-retention";
import { identityHarness } from "@tests/helpers/identity-harness";

describe("identity mail retention on native D1", () => {
  it("preserves an in-flight expired-token envelope, retains its late delivery receipt, and rolls back failed pruning without deleting audit history", async () => {
    const h = identityHarness();
    h.mailer.fail = true;
    const account = await h.bootstrap();
    const db = h.environment.IDENTITY_DB;
    const mail = await db
      .prepare("SELECT id,token_hash FROM identity_mail")
      .first<{ id: string; token_hash: string }>();
    if (!mail) throw new Error("Missing fixture envelope.");
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivery = deliverIdentityMail(h.environment, mail.id, {
      mailer: {
        send: async () => {
          entered();
          await gate;
        },
      },
    });
    await ready;
    const old = Date.now() - IDENTITY_MAIL_RETENTION_MS - 60_000;
    const unconfigured = { ...h.environment, MAIL_FROM: "" };
    try {
      await db.batch([
        db.prepare("UPDATE identity_token SET expires_at=?").bind(old),
        db
          .prepare(
            "INSERT INTO identity_audit(id,actor_user_id,target_user_id,action,reason,created_at) VALUES('retained-audit',?,?,'operator_password_reset_requested','Fixture recovery audit',?)",
          )
          .bind(account.userId, account.userId, old),
      ]);
      await retryIdentityMail(unconfigured);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM identity_mail WHERE lease_id IS NOT NULL AND payload_ciphertext<>''",
          )
          .first("count"),
      ).toBe(1);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM identity_token")
          .first("count"),
      ).toBe(1);
    } finally {
      release();
      expect(await delivery).toBe("sent");
    }
    await retryIdentityMail(unconfigured);
    expect(
      await deliverIdentityMail(h.environment, mail.id, h.dependencies),
    ).toBe("sent");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM identity_token")
        .first("count"),
    ).toBe(1);

    await db.prepare("UPDATE identity_mail SET delivered_at=?").bind(old).run();
    await db.exec(
      "CREATE TRIGGER fixture_mail_prune_failure BEFORE DELETE ON identity_token BEGIN SELECT RAISE(ABORT, 'fixture prune interruption'); END",
    );
    await expect(retryIdentityMail(unconfigured)).rejects.toThrow(
      "fixture prune interruption",
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM identity_mail")
        .first("count"),
    ).toBe(1);
    await db.exec("DROP TRIGGER fixture_mail_prune_failure");
    await retryIdentityMail(unconfigured);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM identity_mail")
        .first("count"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM identity_token")
        .first("count"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT reason FROM identity_audit WHERE id='retained-audit'")
        .first("reason"),
    ).toBe("Fixture recovery audit");
  });

  it("drains bounded terminal and expired-envelope backlogs with delivery unconfigured, keeping recent cancellation receipts", async () => {
    const h = identityHarness();
    const account = await h.bootstrap();
    const db = h.environment.IDENTITY_DB;
    const old = Date.now() - IDENTITY_MAIL_RETENTION_MS - 60_000;
    await db
      .prepare(
        "INSERT INTO identity_token(token_hash,user_id,kind,expires_at,created_at) VALUES('expired-backlog',?,'verify_email',?,?)",
      )
      .bind(account.userId, old, old - 60_000)
      .run();
    await db.batch(
      Array.from({ length: 451 }, (_, index) =>
        db
          .prepare(
            "INSERT INTO identity_mail(id,user_id,token_hash,payload_ciphertext,created_at,next_attempt_at,delivered_at) VALUES(?,?,'expired-backlog',?,?,?,?)",
          )
          .bind(
            `backlog-${index}`,
            account.userId,
            index < 250 ? "" : "fixture-encrypted-envelope",
            old - 60_000,
            Date.now() + 60_000,
            index < 250 ? old : null,
          ),
      ),
    );
    const unconfigured = { ...h.environment, MAIL_FROM: "" };
    await retryIdentityMail(unconfigured);
    const counts = () =>
      db
        .prepare(
          `SELECT
      SUM(delivered_at IS NOT NULL) AS delivered,
      SUM(cancelled_at IS NOT NULL AND payload_ciphertext='') AS cancelled,
      SUM(delivered_at IS NULL AND cancelled_at IS NULL) AS pending
      FROM identity_mail WHERE token_hash='expired-backlog'`,
        )
        .first();
    expect(await counts()).toEqual({
      delivered: 50,
      cancelled: 200,
      pending: 1,
    });
    await retryIdentityMail(unconfigured);
    expect(await counts()).toEqual({
      delivered: 0,
      cancelled: 201,
      pending: 0,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM identity_token WHERE token_hash='expired-backlog'",
        )
        .first("count"),
    ).toBe(1);
    await db
      .prepare(
        "UPDATE identity_mail SET cancelled_at=? WHERE cancelled_at IS NOT NULL",
      )
      .bind(old)
      .run();
    await retryIdentityMail(unconfigured);
    expect(await counts()).toEqual({ delivered: 0, cancelled: 1, pending: 0 });
    await retryIdentityMail(unconfigured);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM identity_mail WHERE token_hash='expired-backlog'",
        )
        .first("count"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM identity_token WHERE token_hash='expired-backlog'",
        )
        .first("count"),
    ).toBe(0);
    expect(h.mailer.messages).toHaveLength(1);
  });
});
