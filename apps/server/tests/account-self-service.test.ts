import { readHttpFailure } from "@tests/helpers/http";
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { IdentityMeResponseSchema } from "@vaskel/contracts/identity";
import {
  ListSessionsResponseSchema,
  UpdateProfileResponseSchema,
  ChangePasswordResponseSchema,
  RevokeSessionResponseSchema,
} from "@vaskel/contracts/account";
import { registerAuthorizedAccount } from "@/server/auth/accounts";
import {
  identityHarness,
  replacementPassword,
  testPassword,
} from "@tests/helpers/identity-harness";

async function setup() {
  const h = identityHarness();
  const account = await h.bootstrap();
  await h.verify();
  const first = await h.signIn();
  const second = await h.signIn();
  return { h, account, first, second };
}
async function sessions(h: ReturnType<typeof identityHarness>, cookie: string) {
  const response = await h.request("/api/identity/sessions", undefined, {
    cookie,
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const result = ListSessionsResponseSchema.parse(await response.json());
  if (result.status !== "sessions") throw new Error(result.status);
  return result;
}

describe("account self-service through primary identity and native D1", () => {
  it("isolates inventory, session management, password checks and sign-in rate limits", async () => {
    const { h, first, second } = await setup();
    const listed = await sessions(h, first.cookie);
    const other = listed.sessions.find((session) => !session.current)!;
    // Native limits use fixed 60-second windows. This test's timeout is shorter
    // than a window, so exhausting two allowances covers a single boundary.
    // Assert refusal and bucket isolation, not the request number at wall-clock rollover.
    const reads = [];
    for (let index = 0; index < 2 * 20 + 1; index++) {
      const response = await h.request("/api/identity/sessions", undefined, {
        cookie: first.cookie,
      });
      reads.push(response.status);
      if (response.status === 429) break;
      expect(response.status).toBe(200);
    }
    expect(reads.at(-1)).toBe(429);
    expect((await h.signIn()).result.status).toBe("authenticated");
    expect(
      (
        await h.request(
          "/api/identity/profile",
          { name: "Still manageable" },
          { cookie: first.cookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          "/api/identity/revoke-session",
          { sessionId: other.id },
          { cookie: first.cookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).status,
    ).toBe(401);
    const passwords = [];
    for (let index = 0; index < 2 * 5 + 1; index++) {
      const response = await h.request(
        "/api/identity/change-password",
        {
          currentPassword: "wrong",
          newPassword: replacementPassword,
          revokeOtherSessions: true,
        },
        { cookie: first.cookie },
      );
      passwords.push(response.status);
      if (response.status === 429) break;
      expect(response.status).toBe(401);
    }
    expect(passwords[0]).toBe(401);
    expect(passwords.at(-1)).toBe(429);
    expect((await h.signIn()).result.status).toBe("authenticated");
    expect(
      (
        await h.request(
          "/api/identity/profile",
          { name: "Management remains separate" },
          { cookie: first.cookie },
        )
      ).status,
    ).toBe(200);
  });
  it("trims names, counts Unicode graphemes and exposes the saved name to other sessions", async () => {
    const { h, first, second } = await setup();
    const name = "👩‍👩‍👧‍👧".repeat(100);
    const response = await h.request(
      "/api/identity/profile",
      { name: `  ${name}  ` },
      { cookie: first.cookie },
    );
    expect(response.status).toBe(200);
    expect(UpdateProfileResponseSchema.parse(await response.json())).toEqual({
      status: "profile_updated",
      displayName: name,
    });
    const profile = IdentityMeResponseSchema.parse(
      await (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).json(),
    );
    expect(profile.status === "authenticated" && profile.user.displayName).toBe(
      name,
    );
    for (const invalid of [" ", `${name}x`]) {
      expect(
        (
          await h.request(
            "/api/identity/profile",
            { name: invalid },
            { cookie: first.cookie },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await h.request(
          "/api/identity/profile",
          { name: "No" },
          { cookie: first.cookie, origin: "https://elsewhere.invalid" },
        )
      ).status,
    ).toBe(403);
  });

  it("leaves credentials, epochs and sessions unchanged on a wrong current password", async () => {
    const { h, first, second } = await setup();
    const before = await env.IDENTITY_DB.prepare(
      "SELECT password FROM identity_account",
    ).first("password");
    const response = await h.request(
      "/api/identity/change-password",
      {
        currentPassword: "incorrect",
        newPassword: replacementPassword,
        revokeOtherSessions: true,
      },
      { cookie: first.cookie },
    );
    expect(response.status).toBe(401);
    expect(await readHttpFailure(response)).toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT password FROM identity_account",
      ).first("password"),
    ).toBe(before);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT authEpoch FROM identity_user",
      ).first("authEpoch"),
    ).toBe(0);
    expect((await sessions(h, second.cookie)).sessions).toHaveLength(2);
  });

  it.each([false, true])(
    "retains current session and fences a delayed old-password signin (revoke others: %s)",
    async (revokeOtherSessions) => {
      let reached!: () => void;
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reachedGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let pause = false;
      const h = identityHarness({
        beforeSessionCreate: async () => {
          if (pause) {
            reached();
            await gate;
          }
        },
      });
      await h.bootstrap();
      await h.verify();
      const first = await h.signIn();
      const other = await h.signIn();
      pause = true;
      const delayed = h.signIn();
      await reachedGate;
      const response = await h.request(
        "/api/identity/change-password",
        {
          currentPassword: testPassword,
          newPassword: replacementPassword,
          revokeOtherSessions,
        },
        { cookie: first.cookie },
      );
      expect(response.status).toBe(200);
      expect(ChangePasswordResponseSchema.parse(await response.json())).toEqual(
        { status: "password_changed" },
      );
      expect(
        await env.IDENTITY_DB.prepare(
          "SELECT authEpoch FROM identity_user",
        ).first("authEpoch"),
      ).toBe(1);
      expect((await sessions(h, first.cookie)).sessions).toHaveLength(
        revokeOtherSessions ? 1 : 2,
      );
      expect(
        (
          await h.request("/api/identity/me", undefined, {
            cookie: other.cookie,
          })
        ).status,
      ).toBe(revokeOtherSessions ? 401 : 200);
      resume();
      const stale = await delayed;
      expect(stale.result).toMatchObject({ code: "UNAUTHENTICATED" });
      expect(
        (
          await h.request("/api/identity/me", undefined, {
            cookie: stale.cookie,
          })
        ).status,
      ).toBe(401);
      pause = false;
      expect((await h.signIn()).result).toMatchObject({
        code: "INVALID_CREDENTIALS",
      });
      expect(
        (await h.signIn("operator@example.invalid", replacementPassword)).result
          .status,
      ).toBe("authenticated");
    },
  );

  it("rolls back password, epoch, retained sessions and reset tokens when a batch statement fails", async () => {
    const { h, first, second } = await setup();
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    await env.IDENTITY_DB.prepare(
      "CREATE TRIGGER fail_account_epoch BEFORE UPDATE OF authEpoch ON identity_session BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END",
    ).run();
    const response = await h.request(
      "/api/identity/change-password",
      {
        currentPassword: testPassword,
        newPassword: replacementPassword,
        revokeOtherSessions: true,
      },
      { cookie: first.cookie },
    );
    expect(response.status).toBe(500);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT authEpoch FROM identity_user",
      ).first("authEpoch"),
    ).toBe(0);
    expect((await sessions(h, second.cookie)).sessions).toHaveLength(2);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT consumed_at FROM identity_token WHERE kind = 'reset_password'",
      ).first("consumed_at"),
    ).toBeNull();
    expect((await h.signIn()).result.status).toBe("authenticated");
  });

  it("lists safe metadata on primary and only revokes an owned session, including current", async () => {
    const { h, first, second } = await setup();
    await env.IDENTITY_DB.prepare(
      "UPDATE identity_session SET userAgent = ?, ipAddress = ?",
    )
      .bind("Mozilla/5.0 Chrome/144.0 sensitive-extra-text", "192.0.2.123")
      .run();
    const withSession = vi.spyOn(env.IDENTITY_DB, "withSession");
    let listing: Awaited<ReturnType<typeof sessions>>;
    try {
      listing = await sessions(h, first.cookie);
      expect(
        withSession.mock.calls.every(([anchor]) => anchor === "first-primary"),
      ).toBe(true);
    } finally {
      withSession.mockRestore();
    }
    expect(listing.sessions).toHaveLength(2);
    expect(
      listing.sessions.every((session) => session.userAgentFamily === "Chrome"),
    ).toBe(true);
    expect(JSON.stringify(listing)).not.toMatch(
      /sensitive-extra-text|192\.0\.2\.123|token|ipAddress/,
    );
    const current = listing.sessions.find((session) => session.current)!;
    const other = listing.sessions.find((session) => !session.current)!;
    await registerAuthorizedAccount(
      {
        email: "member@example.invalid",
        displayName: "Member",
        password: testPassword,
      },
      { authorizationId: crypto.randomUUID(), userId: crypto.randomUUID() },
      h.environment,
      h.dependencies,
    );
    await h.verify("member@example.invalid");
    const member = await h.signIn("member@example.invalid");
    expect(
      (
        await h.request(
          "/api/identity/revoke-session",
          { sessionId: other.id },
          { cookie: member.cookie },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).status,
    ).toBe(200);
    const revoked = await h.request(
      "/api/identity/revoke-session",
      { sessionId: other.id },
      { cookie: first.cookie },
    );
    expect(RevokeSessionResponseSchema.parse(await revoked.json())).toEqual({
      status: "session_revoked",
      current: false,
    });
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).status,
    ).toBe(401);
    const self = await h.request(
      "/api/identity/revoke-session",
      { sessionId: current.id },
      { cookie: first.cookie },
    );
    expect(RevokeSessionResponseSchema.parse(await self.json())).toEqual({
      status: "session_revoked",
      current: true,
    });
    expect(self.headers.getSetCookie()).toEqual([]);
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: first.cookie }))
        .status,
    ).toBe(401);
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: member.cookie,
        })
      ).status,
    ).toBe(200);
  });
  it("lists sign-in time without writing session activity or reviving a revoked principal", async () => {
    const { h, account, first } = await setup();
    const listed = await sessions(h, first.cookie);
    const current = listed.sessions.find((session) => session.current)!;
    const before = await env.IDENTITY_DB.prepare(
      "SELECT expiresAt FROM identity_session WHERE id = ?",
    )
      .bind(current.id)
      .first("expiresAt");
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await env.IDENTITY_DB.prepare(
      "UPDATE identity_session SET updatedAt = ? WHERE id = ?",
    )
      .bind(old, current.id)
      .run();
    await env.IDENTITY_DB.prepare(
      "CREATE TRIGGER reject_session_touch BEFORE UPDATE ON identity_session BEGIN SELECT RAISE(ABORT, 'unexpected_session_write'); END",
    ).run();
    const listedAgain = (await sessions(h, first.cookie)).sessions.find(
      (session) => session.current,
    )!;
    expect(listedAgain).toEqual(current);
    expect(listedAgain).not.toHaveProperty("lastSeenAt");
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: first.cookie }))
        .status,
    ).toBe(200);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT updatedAt FROM identity_session WHERE id = ?",
      )
        .bind(current.id)
        .first("updatedAt"),
    ).toBe(old);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT expiresAt FROM identity_session WHERE id = ?",
      )
        .bind(current.id)
        .first("expiresAt"),
    ).toBe(before);
    const throttle = vi
      .spyOn(env.AUTH_RATE_LIMITER, "limit")
      .mockImplementationOnce(async () => {
        await env.IDENTITY_DB.prepare(
          "DELETE FROM identity_session WHERE id = ?",
        )
          .bind(current.id)
          .run();
        return { success: true };
      });
    try {
      expect(
        (
          await h.request(
            "/api/identity/profile",
            { name: "Rejected" },
            { cookie: first.cookie },
          )
        ).status,
      ).toBe(401);
    } finally {
      throttle.mockRestore();
    }
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT name FROM identity_user WHERE id = ?",
      )
        .bind(account.userId)
        .first("name"),
    ).toBe("Operator");
  });

  it("serializes competing password changes and consumes outstanding reset tokens on success", async () => {
    const { h, first } = await setup();
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    const resetToken = h.mailer.token("reset_password");
    const alternatives = [
      replacementPassword,
      "a third independent passphrase",
    ];
    const responses = await Promise.all(
      alternatives.map((newPassword) =>
        h.request(
          "/api/identity/change-password",
          {
            currentPassword: testPassword,
            newPassword,
            revokeOtherSessions: false,
          },
          { cookie: first.cookie },
        ),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT authEpoch FROM identity_user",
      ).first("authEpoch"),
    ).toBe(1);
    const winningPassword =
      alternatives[responses.findIndex((response) => response.status === 200)]!;
    expect(
      (await h.signIn("operator@example.invalid", winningPassword)).result
        .status,
    ).toBe("authenticated");
    expect(
      (
        await h.request("/api/identity/reset-password", {
          token: resetToken,
          password: testPassword,
        })
      ).status,
    ).toBe(400);
  });
});
