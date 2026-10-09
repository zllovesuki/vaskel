import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth/library";
import { getPrincipal } from "@/server/auth/principal";
import { identityHarness } from "@tests/helpers/identity-harness";

/** Run the library's live schema check against the native migration baseline. */
function schemaCheck() {
  const { options } = createAuth(env);
  return betterAuth({
    ...options,
    advanced: {
      ...options.advanced,
      database: { ...options.advanced.database, validateSchema: true },
    },
  }).api.getSession({ headers: new Headers() });
}

describe("Better Auth setup and native D1 queries", () => {
  it("validates the auth migration baseline and rejects a missing library column", async () => {
    await expect(schemaCheck()).resolves.toBeNull();
    await env.IDENTITY_DB.prepare(
      "ALTER TABLE identity_session DROP COLUMN updatedAt",
    ).run();
    await expect(schemaCheck()).rejects.toThrow(/updatedAt/);
  });

  it("uses two primary reads without schema scans or activity writes and sees revocation on later requests", async () => {
    const h = identityHarness();
    await h.bootstrap();
    await h.verify();
    const login = await h.signIn();
    const request = new Request(`${env.AUTH_ORIGIN}/api/identity/me`, {
      headers: { Cookie: login.cookie },
    });
    const queries: string[] = [];
    const nativeSession = env.IDENTITY_DB.withSession.bind(env.IDENTITY_DB);
    const spy = vi
      .spyOn(env.IDENTITY_DB, "withSession")
      .mockImplementation((anchor) => {
        expect(anchor).toBe("first-primary");
        const session = nativeSession(anchor);
        const prepare = session.prepare.bind(session);
        session.prepare = (query) => {
          queries.push(query);
          return prepare(query);
        };
        return session;
      });
    try {
      for (let pass = 0; pass < 2; pass++) {
        queries.length = 0;
        const principal = await getPrincipal(request, env);
        expect(principal?.userId).toBe(
          login.result.status === "authenticated"
            ? login.result.user.userId
            : undefined,
        );
        expect(queries).toHaveLength(2);
        expect(queries.every((query) => /^select\b/i.test(query.trim()))).toBe(
          true,
        );
        expect(
          queries.some((query) =>
            /sqlite_master|pragma_table_info/i.test(query),
          ),
        ).toBe(false);
      }
      const principal = await getPrincipal(request, env);
      await env.IDENTITY_DB.prepare("DELETE FROM identity_session WHERE id = ?")
        .bind(principal!.sessionId)
        .run();
      expect(await getPrincipal(request, env)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
