import { readHttpFailure } from "@tests/helpers/http";
import { describe, expect, it, vi } from "vitest";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal } from "@/server/directory/owners";
import { principalFailure } from "@/server/actors/shared/policy";
import { sha256Hex } from "@/server/auth/crypto";
import {
  identityHarness,
  replacementPassword,
} from "@tests/helpers/identity-harness";
import {
  RequestPasswordResetResponseSchema,
  ResetPasswordResponseSchema,
} from "@vaskel/contracts/identity";
import { afterIdentityQuery } from "@tests/helpers/identity-query";

describe("identity HTTP and native workerd D1", () => {
  it("does not extend primary-backed authority across delayed or repeated actor dispatch", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    const started = Date.now();
    const principal = await getPrincipal(
      new Request("https://vaskel.test/api/identity/me", {
        headers: { Cookie: login.cookie },
      }),
      h.environment,
    );
    if (!principal) throw new Error("Fixture principal unavailable");
    expect(principal.verifiedAt).toBeGreaterThanOrEqual(started);
    expect(principal.verifiedAt).toBeLessThanOrEqual(Date.now());
    const first = actorPrincipal(principal);
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(principal.verifiedAt + 29_000);
      expect(actorPrincipal(principal)).toEqual(first);
      expect(principalFailure(actorPrincipal(principal))).toBeNull();
      now.mockReturnValue(principal.verifiedAt + 30_000);
      expect(principalFailure(actorPrincipal(principal))).toEqual({
        kind: "unauthenticated",
      });
      const shortSession = {
        ...principal,
        expiresAt: principal.verifiedAt + 15_000,
      };
      expect(actorPrincipal(shortSession).expiresAt).toBe(
        shortSession.expiresAt,
      );
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a session that expires while the primary authority read completes", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    const started = Date.now();
    const expiresAt = started + 60_000;
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt = ?",
    )
      .bind(new Date(expiresAt).toISOString())
      .run();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const completed = vi.fn(() => clock.mockReturnValue(expiresAt + 1));
    const sessions = afterIdentityQuery(
      h.environment.IDENTITY_DB,
      "SELECT u.id,u.name,u.email",
      completed,
    );
    try {
      expect(
        await getPrincipal(
          new Request(`${h.environment.AUTH_ORIGIN}/api/identity/me`, {
            headers: { Cookie: login.cookie },
          }),
          h.environment,
        ),
      ).toBeNull();
      expect(completed).toHaveBeenCalledTimes(1);
    } finally {
      sessions.mockRestore();
      clock.mockRestore();
    }
  });

  it("rejects malformed stored session expiry before constructing a trusted principal", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt = ?",
    )
      .bind("zzzz-invalid-date")
      .run();
    expect(
      await getPrincipal(
        new Request("https://vaskel.test/api/identity/me", {
          headers: { Cookie: login.cookie },
        }),
        h.environment,
      ),
    ).toBeNull();
  });

  it("revokes logout immediately through fresh D1 reads while retaining another session", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const first = await h.signIn();
    const second = await h.signIn();
    expect(
      (await h.request("/api/identity/sign-out", {}, { cookie: first.cookie }))
        .status,
    ).toBe(200);
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: first.cookie }))
        .status,
    ).toBe(401);
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).status,
    ).toBe(200);
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt = ?",
    )
      .bind("2000-01-01T00:00:00.000Z")
      .run();
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).status,
    ).toBe(401);
  });

  it("resets once atomically, revokes every session, and requires the replacement password", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const first = await h.signIn();
    const second = await h.signIn();
    const known = await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    const unknown = await h.request("/api/identity/request-password-reset", {
      email: "missing@example.invalid",
    });
    expect(
      RequestPasswordResetResponseSchema.parse(await known.json()),
    ).toEqual(RequestPasswordResetResponseSchema.parse(await unknown.json()));
    const token = h.mailer.token("reset_password");
    const responses = await Promise.all([
      h.request("/api/identity/reset-password", {
        token,
        password: replacementPassword,
      }),
      h.request("/api/identity/reset-password", {
        token,
        password: replacementPassword,
      }),
    ]);
    const results = await Promise.all(
      responses.map(async (response) =>
        response.ok
          ? ResetPasswordResponseSchema.parse(await response.json()).status
          : (await readHttpFailure(response)).code,
      ),
    );
    expect(results.sort()).toEqual(["INVALID_TOKEN", "password_reset"]);
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: first.cookie }))
        .status,
    ).toBe(401);
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: second.cookie,
        })
      ).status,
    ).toBe(401);
    expect((await h.signIn()).result).toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(
      (await h.signIn("operator@example.invalid", replacementPassword)).result
        .status,
    ).toBe("authenticated");
  });

  it("rejects expired and superseded reset tokens without changing credentials", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    const old = h.mailer.token("reset_password");
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_token SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(Date.now() - 1, await sha256Hex(old))
      .run();
    expect(
      await readHttpFailure(
        await h.request("/api/identity/reset-password", {
          token: old,
          password: replacementPassword,
        }),
      ),
    ).toMatchObject({ code: "INVALID_TOKEN" });
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    const current = h.mailer.token("reset_password");
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    expect(
      await readHttpFailure(
        await h.request("/api/identity/reset-password", {
          token: current,
          password: replacementPassword,
        }),
      ),
    ).toMatchObject({ code: "INVALID_TOKEN" });
    expect((await h.signIn()).result.status).toBe("authenticated");
  });

  it("rolls back token consumption, credentials and revocation on a later reset-write failure", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    const token = h.mailer.token("reset_password");
    await h.environment.IDENTITY_DB.prepare(
      "CREATE TRIGGER fail_identity_epoch BEFORE UPDATE OF authEpoch ON identity_user BEGIN SELECT RAISE(ABORT, 'fixture_reset_failure'); END",
    ).run();
    const response = await h.request("/api/identity/reset-password", {
      token,
      password: replacementPassword,
    });
    expect(response.status).toBe(500);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT consumed_at FROM identity_token WHERE token_hash = ?",
      )
        .bind(await sha256Hex(token))
        .first("consumed_at"),
    ).toBeNull();
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: login.cookie }))
        .status,
    ).toBe(200);
    expect((await h.signIn()).result.status).toBe("authenticated");
    await h.environment.IDENTITY_DB.prepare(
      "DROP TRIGGER fail_identity_epoch",
    ).run();
    expect(
      (
        await h.request("/api/identity/reset-password", {
          token,
          password: replacementPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: login.cookie }))
        .status,
    ).toBe(401);
  });

  it("fences a verified old-password signin whose session write follows password reset", async () => {
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
    await h.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    const token = h.mailer.token("reset_password");
    pause = true;
    const staleLogin = h.signIn();
    await reachedGate;
    expect(
      (
        await h.request("/api/identity/reset-password", {
          token,
          password: replacementPassword,
        })
      ).status,
    ).toBe(200);
    // A replacement sign-in finishes while the old-password attempt is still
    // suspended. It must not overwrite that attempt's captured epoch.
    pause = false;
    const replacement = await h.signIn(
      "operator@example.invalid",
      replacementPassword,
    );
    expect(replacement.result.status).toBe("authenticated");
    resume();
    const stale = await staleLogin;
    expect(stale.result).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      (await h.request("/api/identity/me", undefined, { cookie: stale.cookie }))
        .status,
    ).toBe(401);
    expect(
      (
        await h.request("/api/identity/me", undefined, {
          cookie: replacement.cookie,
        })
      ).status,
    ).toBe(200);
  });
});
