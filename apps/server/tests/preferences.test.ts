import { readHttpFailure } from "@tests/helpers/http";
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { IdentityMeResponseSchema } from "@vaskel/contracts/identity";
import { UpdateAccountPreferencesResponseSchema } from "@vaskel/contracts/preferences";
import {
  applicationHarness,
  decodeApplicationResponse,
} from "@tests/helpers/application-harness";

const path = "/api/account/preferences";

describe("account language through authenticated HTTP and native D1", () => {
  it("starts without an inferred preference, constrains rows and cascades deletion", async () => {
    await reset();
    await applyD1Migrations(env.IDENTITY_DB, env.TEST_MIGRATIONS);
    const userId = crypto.randomUUID();
    await env.IDENTITY_DB.prepare(
      "INSERT INTO identity_user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(
        userId,
        "保持した名前",
        "retained@example.invalid",
        "2026-09-16T00:00:00Z",
        "2026-09-16T00:00:00Z",
      )
      .run();
    await applyD1Migrations(env.IDENTITY_DB, env.TEST_MIGRATIONS);
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT name FROM identity_user WHERE id = ?",
      )
        .bind(userId)
        .first("name"),
    ).toBe("保持した名前");
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT count(*) AS count FROM identity_preferences",
      ).first("count"),
    ).toBe(0);
    const insert = (language: string, revision: number) =>
      env.IDENTITY_DB.prepare(
        "INSERT INTO identity_preferences (user_id, language, revision) VALUES (?, ?, ?)",
      )
        .bind(userId, language, revision)
        .run();
    await expect(insert("zh", 1)).rejects.toThrow();
    await expect(insert("ja", 0)).rejects.toThrow();
    await expect(insert("ja", 1.5)).rejects.toThrow();
    await insert("ja", 1);
    await env.IDENTITY_DB.prepare("DELETE FROM identity_user WHERE id = ?")
      .bind(userId)
      .run();
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT count(*) AS count FROM identity_preferences",
      ).first("count"),
    ).toBe(0);
  });

  it("exposes unsaved defaults, serializes concurrent choices and refreshes independent signed-in devices on primary", async () => {
    const h = applicationHarness();
    const first = await h.bootstrap();
    const second = await h.signIn(h.client(), "operator@example.invalid");
    expect(first.profile?.preferences).toEqual({ language: null, revision: 0 });
    expect(second.profile?.preferences).toEqual({
      language: null,
      revision: 0,
    });
    const authorityBefore = await env.IDENTITY_DB.prepare(
      "SELECT id, authEpoch FROM identity_session ORDER BY id",
    ).all();
    const initial = await first.request(path, { language: "zh-Hant" });
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toBe("private, no-store");
    expect(initial.headers.get("X-Vaskel-D1-Bookmark")).toBeTruthy();
    expect(
      await decodeApplicationResponse(
        initial,
        UpdateAccountPreferencesResponseSchema,
      ),
    ).toEqual({
      kind: "preferences_updated",
      preferences: { language: "zh-Hant", revision: 1 },
    });
    const writes = await Promise.all([
      first.request(path, { language: "zh-Hans" }),
      second.request(path, { language: "ja" }),
    ]);
    const results = await Promise.all(
      writes.map((response) =>
        decodeApplicationResponse(
          response,
          UpdateAccountPreferencesResponseSchema,
        ),
      ),
    );
    const committed = results
      .flatMap((result) =>
        result.kind === "preferences_updated" ? [result.preferences] : [],
      )
      .sort((a, b) => a.revision - b.revision);
    expect(committed.map((preferences) => preferences.revision)).toEqual([
      2, 3,
    ]);
    const last = committed[1];
    if (!last || !last.language)
      throw new Error("Concurrent writes did not commit.");
    second.bookmark = undefined;
    const withSession = vi.spyOn(env.IDENTITY_DB, "withSession");
    try {
      const profile = await decodeApplicationResponse(
        await second.request("/api/identity/me", undefined, {
          headers: { "X-Vaskel-D1-Bookmark": "old-directory-bookmark" },
        }),
        IdentityMeResponseSchema,
      );
      expect(profile.status).toBe("authenticated");
      if (profile.status === "authenticated")
        expect(profile.user.preferences).toEqual(last);
      expect(withSession.mock.calls.length).toBeGreaterThan(0);
      expect(
        withSession.mock.calls.every(([anchor]) => anchor === "first-primary"),
      ).toBe(true);
    } finally {
      withSession.mockRestore();
    }
    const retry = await decodeApplicationResponse(
      await first.request(path, { language: last.language }),
      UpdateAccountPreferencesResponseSchema,
    );
    expect(retry).toEqual({
      kind: "preferences_updated",
      preferences: { language: last.language, revision: 4 },
    });
    expect(
      (
        await env.IDENTITY_DB.prepare(
          "SELECT id, authEpoch FROM identity_session ORDER BY id",
        ).all()
      ).results,
    ).toEqual(authorityBefore.results);
    const fresh = await h.signIn(h.client(), "operator@example.invalid");
    expect(fresh.profile?.preferences).toEqual({
      language: last.language,
      revision: 4,
    });
  });

  it("preserves origin, identity, strict JSON, body and rate gates without writing rejected choices", async () => {
    const h = applicationHarness();
    const user = await h.bootstrap();
    expect((await h.anonymous.request(path, { language: "ja" })).status).toBe(
      401,
    );
    for (const origin of [null, "https://foreign.invalid"]) {
      const response = await user.request(path, { language: "ja" }, { origin });
      expect(response.status).toBe(403);
      expect((await readHttpFailure(response)).code).toBe("ORIGIN_REJECTED");
    }
    for (const body of [
      { language: "zh" },
      { language: null },
      { language: "en", revision: 10 },
      { language: "ja", userId: crypto.randomUUID() },
      {},
    ]) {
      const response = await user.request(path, body);
      expect(response.status).toBe(400);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect((await user.request(path, undefined, { rawBody: "{" })).status).toBe(
      400,
    );
    expect(
      (
        await user.request(
          path,
          { language: "ja" },
          { headers: { "Content-Type": "text/plain" } },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await user.request(path, undefined, {
          rawBody: "x".repeat(256 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    const limit = vi
      .spyOn(env.APPLICATION_RATE_LIMITER, "limit")
      .mockResolvedValueOnce({ success: false });
    try {
      const response = await user.request(path, { language: "ja" });
      expect(response.status).toBe(429);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "CAPACITY",
      });
    } finally {
      limit.mockRestore();
    }
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT count(*) AS count FROM identity_preferences",
      ).first("count"),
    ).toBe(0);
  });

  it.each([
    { revoke: "session", existing: false },
    { revoke: "epoch", existing: false },
    { revoke: "session", existing: true },
    { revoke: "epoch", existing: true },
  ])(
    "rejects $revoke revocation after principal resolution (existing preference: $existing)",
    async ({ revoke, existing }) => {
      const h = applicationHarness();
      const user = await h.bootstrap();
      if (existing)
        expect((await user.request(path, { language: "en" })).status).toBe(200);
      // The real application rate check runs after requirePrincipal and before
      // the route. Revoke here to exercise the actual HTTP/write race boundary.
      const limit = vi
        .spyOn(env.APPLICATION_RATE_LIMITER, "limit")
        .mockImplementationOnce(async () => {
          await env.IDENTITY_DB.prepare(
            revoke === "session"
              ? "DELETE FROM identity_session WHERE userId = ?"
              : "UPDATE identity_user SET authEpoch = authEpoch + 1 WHERE id = ?",
          )
            .bind(user.profile!.userId)
            .run();
          return { success: true };
        });
      try {
        const response = await user.request(path, { language: "ja" });
        expect(response.status).toBe(401);
        expect(await readHttpFailure(response)).toMatchObject({
          code: "UNAUTHENTICATED",
        });
      } finally {
        limit.mockRestore();
      }
      expect(
        await env.IDENTITY_DB.prepare(
          "SELECT language, revision FROM identity_preferences WHERE user_id = ?",
        )
          .bind(user.profile!.userId)
          .first(),
      ).toEqual(existing ? { language: "en", revision: 1 } : null);
    },
  );
});
