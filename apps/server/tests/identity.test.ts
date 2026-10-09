import { readHttpFailure } from "@tests/helpers/http";
import { describe, expect, it } from "vitest";
import { getPrincipal } from "@/server/auth/principal";
import {
  bootstrapOperator,
  registerAuthorizedAccount,
} from "@/server/auth/accounts";
import { sha256Hex } from "@/server/auth/crypto";
import { createAuth } from "@/server/auth/library";
import {
  identityHarness,
  replacementPassword,
  testPassword,
} from "@tests/helpers/identity-harness";
import {
  IdentityMeResponseSchema,
  VerifyEmailResponseSchema,
} from "@vaskel/contracts/identity";

describe("identity HTTP and native workerd D1", () => {
  it("rejects absent/foreign mutation origins and all public unrestricted signup routes", async () => {
    const h = identityHarness();
    const body = {
      email: "operator@example.invalid",
      password: testPassword,
      displayName: "Operator",
      bootstrapSecret: h.environment.OPERATOR_BOOTSTRAP_SECRET,
    };
    for (const origin of [null, "https://attacker.invalid", "null"]) {
      const response = await h.request("/api/identity/bootstrap", body, {
        origin,
      });
      expect(response.status).toBe(403);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "ORIGIN_REJECTED",
        status: 403,
      });
      expect(response.headers.get("X-Request-ID")).toBeTruthy();
    }
    const foreignAuth = await h.request("/api/auth/sign-in/email", body, {
      origin: "https://attacker.invalid",
    });
    expect(foreignAuth.status).toBe(403);
    expect((await readHttpFailure(foreignAuth)).code).toBe("ORIGIN_REJECTED");
    const publicSignup = await h.request("/api/auth/sign-up/email", {
      email: body.email,
      password: testPassword,
      name: "Attacker",
    });
    expect(publicSignup.status).toBe(403);
    expect(await readHttpFailure(publicSignup)).toMatchObject({
      code: "FORBIDDEN",
    });
    const nativeSignup = await createAuth(h.environment).handler(
      new Request("https://vaskel.test/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          Origin: "https://vaskel.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: body.email,
          password: testPassword,
          name: "Attacker",
        }),
      }),
    );
    expect(nativeSignup.status).toBe(400);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_user",
      ).first("count"),
    ).toBe(0);
  });

  it("signs in through same-port HTTP loopback aliases while rejecting other origins before session creation", async () => {
    const h = identityHarness();
    const registered = await h.bootstrap();
    await h.verify();
    const localEnvironment = {
      ...h.environment,
      AUTH_ORIGIN: "http://127.0.0.1:5177",
    };
    const credentials = {
      email: "operator@example.invalid",
      password: testPassword,
    };
    const rejected: NonNullable<Parameters<typeof h.request>[2]>[] = [
      { requestOrigin: "http://localhost:5177", origin: null },
      { requestOrigin: "http://localhost:5177", origin: "null" },
      {
        requestOrigin: "http://localhost:5177",
        origin: "http://127.0.0.1:5177",
      },
      { requestOrigin: "http://localhost:5178" },
      { requestOrigin: "https://localhost:5177" },
      { requestOrigin: "http://preview.invalid:5177" },
      { requestOrigin: "http://preview.localhost:5177" },
      {
        requestOrigin: "http://localhost:5177",
        headers: { "Sec-Fetch-Site": "cross-site" },
      },
      {
        requestOrigin: "https://localhost:5177",
        environment: {
          ...localEnvironment,
          AUTH_ORIGIN: "https://127.0.0.1:5177",
        },
      },
      {
        requestOrigin: "http://localhost:5177",
        environment: h.environment,
      },
      {
        requestOrigin: "https://other.vaskel.test",
        environment: h.environment,
      },
    ];
    for (const options of rejected) {
      const response = await h.request("/api/identity/sign-in", credentials, {
        environment: localEnvironment,
        ...options,
      });
      expect(response.status).toBe(403);
      expect((await readHttpFailure(response)).code).toBe("ORIGIN_REJECTED");
    }
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_session",
      ).first("count"),
    ).toBe(0);

    for (const requestOrigin of [
      "http://localhost:5177",
      "http://127.0.0.1:5177",
      "http://[::1]:5177",
    ]) {
      const options = { requestOrigin, environment: localEnvironment };
      const anonymous = await h.request("/api/identity/me", undefined, {
        ...options,
        origin: null,
      });
      expect(anonymous.status).toBe(401);
      expect(await readHttpFailure(anonymous)).toMatchObject({
        code: "UNAUTHENTICATED",
      });
      const response = await h.request(
        "/api/identity/sign-in",
        credentials,
        options,
      );
      expect(response.status).toBe(200);
      expect(
        IdentityMeResponseSchema.parse(await response.json()),
      ).toMatchObject({
        status: "authenticated",
        user: { userId: registered.userId },
      });
      const sessionCookie = response.headers
        .getSetCookie()
        .find((cookie) => cookie.includes("session_token="));
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie?.toLowerCase()).toContain("samesite=lax");
      expect(sessionCookie?.toLowerCase()).not.toContain("domain=");
      expect(sessionCookie).not.toContain("Secure");
      const cookie = sessionCookie?.split(";")[0];
      if (!cookie) throw new Error("The alias sign-in did not issue a cookie.");
      const authenticated = { ...options, cookie };
      const me = await h.request("/api/identity/me", undefined, {
        ...authenticated,
        origin: null,
      });
      expect(me.status).toBe(200);
      expect(IdentityMeResponseSchema.parse(await me.json())).toMatchObject({
        status: "authenticated",
        user: { userId: registered.userId },
      });
      const signedOut = await h.request(
        "/api/identity/sign-out",
        {},
        authenticated,
      );
      expect(signedOut.status).toBe(200);
      // Best-effort cleanup of cached private bytes after a real sign-out.
      expect(signedOut.headers.get("Clear-Site-Data")).toBe('"cache"');
      expect(
        (await h.request("/api/identity/me", undefined, authenticated)).status,
      ).toBe(401);
    }
  });

  it("uses a configured expiring secret and a singleton atomic operator claim under races", async () => {
    const h = identityHarness();
    const base = {
      email: "operator@example.invalid",
      displayName: "Operator",
      password: testPassword,
      bootstrapSecret: h.environment.OPERATOR_BOOTSTRAP_SECRET,
    };
    expect(
      (
        await bootstrapOperator(
          { ...base, bootstrapSecret: "A".repeat(43) },
          h.environment,
          h.dependencies,
        )
      ).status,
    ).toBe("forbidden");
    expect(
      (
        await bootstrapOperator(
          base,
          {
            ...h.environment,
            OPERATOR_BOOTSTRAP_EXPIRES_AT: "2000-01-01T00:00:00Z",
          },
          h.dependencies,
        )
      ).status,
    ).toBe("bootstrap_expired");
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_operator",
      ).first("count"),
    ).toBe(0);
    const results = await Promise.all([
      bootstrapOperator(base, h.environment, h.dependencies),
      bootstrapOperator(
        { ...base, email: "other@example.invalid" },
        h.environment,
        h.dependencies,
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "bootstrap_complete",
      "registered",
    ]);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_user",
      ).first("count"),
    ).toBe(1);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_account",
      ).first("count"),
    ).toBe(1);
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_operator",
      ).first("count"),
    ).toBe(1);
    expect(
      (await bootstrapOperator(base, h.environment, h.dependencies)).status,
    ).toBe("bootstrap_complete");
    expect((await h.request("/api/identity/bootstrap")).status).toBe(200);
  });

  it("rolls back a later credential-write failure including the operator claim and can retry", async () => {
    const h = identityHarness();
    await h.environment.IDENTITY_DB.prepare(
      "CREATE TRIGGER fail_identity_account BEFORE INSERT ON identity_account BEGIN SELECT RAISE(ABORT, 'fixture_account_failure'); END",
    ).run();
    const response = await h.request("/api/identity/bootstrap", {
      email: "operator@example.invalid",
      displayName: "Operator",
      password: testPassword,
      bootstrapSecret: h.environment.OPERATOR_BOOTSTRAP_SECRET,
    });
    expect(response.status).toBe(500);
    for (const table of [
      "identity_user",
      "identity_account",
      "identity_operator",
      "identity_mail",
      "identity_token",
    ])
      expect(
        await h.environment.IDENTITY_DB.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).first("count"),
      ).toBe(0);
    await h.environment.IDENTITY_DB.prepare(
      "DROP TRIGGER fail_identity_account",
    ).run();
    expect((await h.bootstrap()).status).toBe("registered");
  });

  it("fails closed before bootstrap writes when mail delivery is unconfigured", async () => {
    const h = identityHarness();
    const result = await bootstrapOperator(
      {
        email: "operator@example.invalid",
        displayName: "Operator",
        password: testPassword,
        bootstrapSecret: h.environment.OPERATOR_BOOTSTRAP_SECRET,
      },
      { ...h.environment, MAIL_FROM: "" },
    );
    expect(result.status).toBe("unavailable");
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_user",
      ).first("count"),
    ).toBe(0);
  });

  it("requires verification, consumes verification once under races, and emits safe session cookies", async () => {
    const h = identityHarness();
    const registered = await h.bootstrap();
    expect((await h.signIn()).result).toMatchObject({
      code: "EMAIL_UNVERIFIED",
    });
    const token = h.mailer.token("verify_email");
    const verified = await Promise.all([
      h.request("/api/identity/verify-email", { token }),
      h.request("/api/identity/verify-email", { token }),
    ]);
    const results = await Promise.all(
      verified.map(async (response) => {
        if (!response.ok) return (await readHttpFailure(response)).code;
        return VerifyEmailResponseSchema.parse(await response.json()).status;
      }),
    );
    expect(results.sort()).toEqual(["INVALID_TOKEN", "email_verified"]);
    const login = await h.signIn();
    expect(login.result.status).toBe("authenticated");
    if (login.result.status !== "authenticated")
      throw new Error("Fixture login failed.");
    expect(login.result.user.userId).toBe(registered.userId);
    expect(login.result.user.isOperator).toBe(true);
    expect(login.result).not.toHaveProperty("token");
    const sessionCookie = login.response.headers
      .getSetCookie()
      .find((cookie) => cookie.includes("session_token="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie?.toLowerCase()).toContain("samesite=lax");
    const me = IdentityMeResponseSchema.parse(
      await (
        await h.request("/api/identity/me", undefined, { cookie: login.cookie })
      ).json(),
    );
    expect(me.status).toBe("authenticated");
    const principal = await getPrincipal(
      new Request("https://vaskel.test/api/identity/me", {
        headers: { Cookie: login.cookie },
      }),
      h.environment,
    );
    expect(typeof principal?.expiresAt).toBe("number");
  });

  it("rejects expired verification links and replacement links supersede older ones", async () => {
    const h = identityHarness();
    await h.bootstrap();
    const old = h.mailer.token("verify_email");
    await h.environment.IDENTITY_DB.prepare(
      "UPDATE identity_token SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(Date.now() - 1, await sha256Hex(old))
      .run();
    expect(
      await readHttpFailure(
        await h.request("/api/identity/verify-email", { token: old }),
      ),
    ).toMatchObject({ code: "INVALID_TOKEN" });
    expect(
      (
        await h.request("/api/identity/resend-verification", {
          email: "operator@example.invalid",
        })
      ).status,
    ).toBe(202);
    expect(await (await h.verify()).json()).toEqual({
      status: "email_verified",
    });
    expect(
      await readHttpFailure(
        await h.request("/api/identity/verify-email", { token: old }),
      ),
    ).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("records authorized registration receipts, rejects command changes, and never grants operator", async () => {
    const h = identityHarness();
    await h.bootstrap();
    const authorization = {
      authorizationId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
    };
    const body = {
      email: "member@example.invalid",
      displayName: "Member",
      password: testPassword,
    };
    const results = await Promise.all([
      registerAuthorizedAccount(
        body,
        authorization,
        h.environment,
        h.dependencies,
      ),
      registerAuthorizedAccount(
        {
          password: body.password,
          displayName: body.displayName,
          email: body.email,
        },
        authorization,
        h.environment,
        h.dependencies,
      ),
    ]);
    expect(results.every((result) => result.status === "registered")).toBe(
      true,
    );
    expect(
      (
        await registerAuthorizedAccount(
          { ...body, password: replacementPassword },
          authorization,
          h.environment,
          h.dependencies,
        )
      ).status,
    ).toBe("authorization_conflict");
    expect(
      await h.environment.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM identity_registration",
      ).first("count"),
    ).toBe(1);
    await h.verify(body.email);
    const login = await h.signIn(body.email);
    expect(login.result.status).toBe("authenticated");
    if (login.result.status === "authenticated")
      expect(login.result.user.isOperator).toBe(false);
  });
});
