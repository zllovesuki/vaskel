import { describe, expect, it, vi } from "vitest";
import { getPrincipal } from "@/server/auth/principal";
import { registerAuthorizedAccount } from "@/server/auth/accounts";
import {
  configuredMailer,
  deliverIdentityMail,
  retryIdentityMail,
} from "@/server/auth/mail";
import { operatorRequestPasswordReset } from "@/server/auth/tokens";
import { setServerCreationGrant } from "@/server/directory/grants";
import { identityHarness, testPassword } from "@tests/helpers/identity-harness";
import { afterIdentityQuery } from "@tests/helpers/identity-query";

describe("identity HTTP and native workerd D1", () => {
  it("sends a fixture through the local structured Cloudflare email binding", async () => {
    const h = identityHarness();
    const mailer = configuredMailer(h.environment);
    if (!mailer) throw new Error("The local email binding is not configured.");
    await expect(
      mailer.send({
        to: "native-binding@example.invalid",
        subject: "vaskel. local email binding fixture",
        text: "Local binding integration fixture. This message contains no credentials or account links.",
      }),
    ).resolves.toBeUndefined();
  });

  it("retains encrypted durable mail after interruption and retries without recreating bootstrap", async () => {
    const h = identityHarness();
    h.mailer.fail = true;
    const result = await h.bootstrap();
    expect(result.mailDelivery).toBe("pending");
    const mail = await h.environment.IDENTITY_DB.prepare(
      "SELECT id,payload_ciphertext,delivered_at FROM identity_mail",
    ).first<{
      id: string;
      payload_ciphertext: string;
      delivered_at: number | null;
    }>();
    expect(mail?.payload_ciphertext).not.toContain("operator@example.invalid");
    expect(mail?.payload_ciphertext).not.toContain("https://vaskel.test");
    expect(mail?.delivered_at).toBeNull();
    h.mailer.fail = false;
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_mail SET next_attempt_at = 0",
    ).run();
    expect(
      await retryIdentityMail(h.environment, { limit: 1 }, h.dependencies),
    ).toEqual({ sent: 1, pending: 0 });
    expect(h.mailer.messages).toHaveLength(1);
    expect((await h.verify()).status).toBe(200);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT payload_ciphertext FROM identity_mail",
      ).first("payload_ciphertext"),
    ).toBe("");
    if (!mail) throw new Error("Fixture mail missing.");
    expect(
      await deliverIdentityMail(h.environment, mail.id, h.dependencies),
    ).toBe("sent");
    expect(h.mailer.messages).toHaveLength(1);
  });

  it("leases concurrent mail retries and discards expired envelopes without sending", async () => {
    const h = identityHarness();
    h.mailer.fail = true;
    await h.bootstrap();
    const mail = await h.environment.IDENTITY_DB.prepare(
      "SELECT id FROM identity_mail",
    ).first<{ id: string }>();
    if (!mail) throw new Error("Fixture mail missing.");
    h.mailer.fail = false;
    await Promise.all([
      deliverIdentityMail(h.environment, mail.id, h.dependencies),
      deliverIdentityMail(h.environment, mail.id, h.dependencies),
    ]);
    expect(h.mailer.messages).toHaveLength(1);
    h.mailer.fail = true;
    await h.request("/api/identity/resend-verification", {
      email: "operator@example.invalid",
    });
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_token SET expires_at = ? WHERE consumed_at IS NULL",
    )
      .bind(Date.now() - 1)
      .run();
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_mail SET next_attempt_at = 0 WHERE delivered_at IS NULL",
    ).run();
    h.mailer.fail = false;
    expect(
      await retryIdentityMail(h.environment, { limit: 5 }, h.dependencies),
    ).toEqual({ sent: 0, pending: 1 });
    expect(h.mailer.messages).toHaveLength(1);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_mail WHERE cancelled_at IS NOT NULL AND payload_ciphertext = ''",
      ).first("count"),
    ).toBe(1);
  });

  it("cancels an envelope whose token expires during its native read", async () => {
    const h = identityHarness();
    h.mailer.fail = true;
    await h.bootstrap();
    const mail = await h.environment.IDENTITY_DB.prepare(
      "SELECT id, token_hash FROM identity_mail",
    ).first<{ id: string; token_hash: string }>();
    if (!mail) throw new Error("Fixture mail missing");
    const started = Date.now();
    const expiresAt = started + 1_000;
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_token SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(expiresAt, mail.token_hash)
      .run();
    h.mailer.fail = false;
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const completed = vi.fn(() => clock.mockReturnValue(expiresAt + 1));
    const sessions = afterIdentityQuery(
      h.environment.IDENTITY_DB,
      "SELECT expires_at,consumed_at FROM identity_token",
      completed,
    );
    try {
      expect(
        await deliverIdentityMail(h.environment, mail.id, h.dependencies),
      ).toBe("pending");
      expect(completed).toHaveBeenCalledTimes(1);
      expect(h.mailer.messages).toHaveLength(0);
      expect(
        await h.environment.IDENTITY_DB.prepare(
          "SELECT cancelled_at, payload_ciphertext, lease_id FROM identity_mail WHERE id = ?",
        )
          .bind(mail.id)
          .first(),
      ).toEqual({
        cancelled_at: expiresAt + 1,
        payload_ciphertext: "",
        lease_id: null,
      });
    } finally {
      sessions.mockRestore();
      clock.mockRestore();
    }
  });

  it("starts mail retry backoff when a slow delivery fails", async () => {
    const h = identityHarness();
    h.mailer.fail = true;
    await h.bootstrap();
    const mail = await h.environment.IDENTITY_DB.prepare(
      "SELECT id FROM identity_mail",
    ).first<{ id: string }>();
    if (!mail) throw new Error("Fixture mail missing");
    const started = Date.now();
    const failedAt = started + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const send = vi.spyOn(h.mailer, "send").mockImplementationOnce(async () => {
      // The provider's failed I/O completes after this attempt's lease interval.
      clock.mockReturnValue(failedAt);
      throw new Error("Test-only delayed mail failure");
    });
    try {
      expect(
        await deliverIdentityMail(h.environment, mail.id, h.dependencies),
      ).toBe("pending");
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await h.environment.IDENTITY_DB.prepare(
          "SELECT next_attempt_at, attempts, lease_id FROM identity_mail WHERE id = ?",
        )
          .bind(mail.id)
          .first(),
      ).toEqual({
        next_attempt_at: failedAt + 20_000,
        attempts: 2,
        lease_id: null,
      });
    } finally {
      send.mockRestore();
      clock.mockRestore();
    }
  });

  it("refuses operator recovery if its session expires during target lookup", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    const principal = await getPrincipal(
      new Request(h.environment.AUTH_ORIGIN, {
        headers: { Cookie: login.cookie },
      }),
      h.environment,
    );
    if (!principal) throw new Error("Fixture principal missing");
    const started = Date.now();
    const expiresAt = started + 60_000;
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt = ? WHERE id = ?",
    )
      .bind(new Date(expiresAt).toISOString(), principal.sessionId)
      .run();
    const counts = () =>
      h.environment.IDENTITY_DB.prepare(
        `SELECT
      (SELECT COUNT(*) FROM identity_audit) AS audits,
      (SELECT COUNT(*) FROM identity_token) AS tokens,
      (SELECT COUNT(*) FROM identity_mail) AS mails`,
      ).first();
    const before = await counts();
    const sent = h.mailer.messages.length;
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const completed = vi.fn(() => clock.mockReturnValue(expiresAt + 1));
    const sessions = afterIdentityQuery(
      h.environment.IDENTITY_DB,
      "SELECT id,email FROM identity_user WHERE id = ?",
      completed,
    );
    try {
      expect(
        await operatorRequestPasswordReset(
          principal,
          {
            userId: principal.userId,
            reason: "Delayed operator recovery fixture",
          },
          h.environment,
          h.dependencies,
        ),
      ).toEqual({ status: "forbidden" });
      expect(completed).toHaveBeenCalledTimes(1);
      expect(await counts()).toEqual(before);
      expect(h.mailer.messages).toHaveLength(sent);
    } finally {
      sessions.mockRestore();
      clock.mockRestore();
    }
  });

  it("bounds operator authority by database time when the Worker clock lags", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    const principal = await getPrincipal(
      new Request(h.environment.AUTH_ORIGIN, {
        headers: { Cookie: login.cookie },
      }),
      h.environment,
    );
    if (!principal) throw new Error("Fixture principal missing");
    const expiredAt = Date.now() - 1_000;
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt = ? WHERE id = ?",
    )
      .bind(new Date(expiredAt).toISOString(), principal.sessionId)
      .run();
    // The lagging Worker clock still considers the session live; the database clock does not.
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiredAt - 60_000);
    try {
      expect(
        await operatorRequestPasswordReset(
          principal,
          { userId: principal.userId, reason: "Lagging clock fixture" },
          h.environment,
          h.dependencies,
        ),
      ).toEqual({ status: "forbidden" });
      expect(
        await setServerCreationGrant(
          principal,
          principal.userId,
          true,
          h.environment.IDENTITY_DB.withSession("first-primary"),
        ),
      ).toEqual({ kind: "forbidden" });
    } finally {
      clock.mockRestore();
    }
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT (SELECT COUNT(*) FROM identity_audit) + (SELECT COUNT(*) FROM instance_capability) + (SELECT COUNT(*) FROM directory_audit) AS count",
      ).first("count"),
    ).toBe(0);
  });

  it("audits operator assistance and refuses ordinary members without exposing passwords", async () => {
    const h = identityHarness();
    const operator = await h.bootstrap();
    await h.verify();
    const authorization = {
      authorizationId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
    };
    await registerAuthorizedAccount(
      {
        email: "member@example.invalid",
        displayName: "Member",
        password: testPassword,
      },
      authorization,
      h.environment,
      h.dependencies,
    );
    await h.verify("member@example.invalid");
    const memberLogin = await h.signIn("member@example.invalid");
    expect(
      (
        await h.request(
          "/api/identity/operator/request-password-reset",
          { userId: operator.userId, reason: "Fixture assistance" },
          { cookie: memberLogin.cookie },
        )
      ).status,
    ).toBe(403);
    const operatorLogin = await h.signIn();
    const response = await h.request(
      "/api/identity/operator/request-password-reset",
      {
        userId: authorization.userId,
        reason: "Requested account recovery assistance",
      },
      { cookie: operatorLogin.cookie },
    );
    expect(await response.json()).toEqual({ status: "accepted" });
    const audit = await h.environment.IDENTITY_DB.prepare(
      "SELECT actor_user_id,target_user_id,action,reason FROM identity_audit",
    ).first();
    expect(audit).toEqual({
      actor_user_id: operator.userId,
      target_user_id: authorization.userId,
      action: "operator_password_reset_requested",
      reason: "Requested account recovery assistance",
    });
    expect(
      h.mailer.token("reset_password", "member@example.invalid"),
    ).toHaveLength(43);
  });
});
