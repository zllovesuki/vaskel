import { readHttpFailure } from "@tests/helpers/http";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_ACCOUNT_HEADER,
  IdentityMeResponseSchema,
  SignInResponseSchema,
} from "@vaskel/contracts/identity";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { UpdateAccountPreferencesResponseSchema } from "@vaskel/contracts/preferences";
import {
  applicationHarness,
  decodeApplicationResponse,
  messageCommand,
} from "@tests/helpers/application-harness";
import { testPassword } from "@tests/helpers/identity-harness";

describe("displayed account and shared-cookie correlation", () => {
  it("refuses stale-account preference and shared-owner commands before dispatch, while matching cookies still authorize", async () => {
    const h = applicationHarness();
    const original = await h.bootstrap();
    const server = await h.createServer(original);
    const { member: replacement } = await h.registerMember(
      original,
      server.owner.id,
    );
    const stale = {
      headers: { [EXPECTED_ACCOUNT_HEADER]: original.profile!.userId },
    };
    const matching = {
      headers: { [EXPECTED_ACCOUNT_HEADER]: replacement.profile!.userId },
    };
    const command = messageCommand(
      server.channelId,
      "Only the matching account sends this.",
    );
    const preference = await replacement.request(
      "/api/account/preferences",
      { language: "ja" },
      stale,
    );
    expect(preference.status).toBe(401);
    expect(await readHttpFailure(preference)).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const rejectedSend = await replacement.request(
      `${server.path}/send`,
      command,
      stale,
    );
    expect(rejectedSend.status).toBe(401);
    expect(await readHttpFailure(rejectedSend)).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(
      await env.IDENTITY_DB.prepare(
        "SELECT count(*) AS count FROM identity_preferences",
      ).first("count"),
    ).toBe(0);
    const before = await decodeApplicationResponse(
      await replacement.request(
        `${server.path}/snapshot`,
        { channelId: server.channelId },
        matching,
      ),
      MessagingOutcomeSchema,
    );
    expect(before.kind).toBe("snapshot");
    if (before.kind === "snapshot") expect(before.messages).toEqual([]);

    const saved = await decodeApplicationResponse(
      await replacement.request(
        "/api/account/preferences",
        { language: "ja" },
        matching,
      ),
      UpdateAccountPreferencesResponseSchema,
    );
    expect(saved).toEqual({
      kind: "preferences_updated",
      preferences: { language: "ja", revision: 1 },
    });
    expect(
      (await replacement.request(`${server.path}/send`, command, matching))
        .status,
    ).toBe(200);
    const after = await decodeApplicationResponse(
      await replacement.request(
        `${server.path}/snapshot`,
        { channelId: server.channelId },
        matching,
      ),
      MessagingOutcomeSchema,
    );
    expect(after.kind).toBe("snapshot");
    if (after.kind === "snapshot")
      expect(after.messages).toMatchObject([
        { authorId: replacement.profile!.userId, body: command.body },
      ]);
    // The header cannot select an account or confer its authority.
    expect(
      (
        await original.request(
          "/api/account/preferences",
          { language: "en" },
          matching,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await h.anonymous.request(
          "/api/account/preferences",
          { language: "en" },
          matching,
        )
      ).status,
    ).toBe(401);
  });

  it("leaves the replacement session and cookie intact on late sign-out, while discovery and matching sign-out still work", async () => {
    const h = applicationHarness();
    const original = await h.bootstrap();
    const server = await h.createServer(original);
    const { member: replacement } = await h.registerMember(
      original,
      server.owner.id,
    );
    const stale = {
      headers: { [EXPECTED_ACCOUNT_HEADER]: original.profile!.userId },
    };
    const signOut = await replacement.request(
      "/api/identity/sign-out",
      {},
      stale,
    );
    expect(signOut.status).toBe(401);
    expect(await readHttpFailure(signOut)).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(signOut.headers.getSetCookie()).toEqual([]);
    const discovered = await decodeApplicationResponse(
      await replacement.request("/api/identity/me", undefined, stale),
      IdentityMeResponseSchema,
    );
    expect(discovered).toMatchObject({
      status: "authenticated",
      user: { userId: replacement.profile!.userId },
    });
    const signedIn = await decodeApplicationResponse(
      await replacement.request(
        "/api/identity/sign-in",
        {
          email: replacement.profile!.email,
          password: testPassword,
        },
        stale,
      ),
      SignInResponseSchema,
    );
    expect(signedIn).toMatchObject({
      status: "authenticated",
      user: { userId: replacement.profile!.userId },
    });
    const matching = await replacement.request(
      "/api/identity/sign-out",
      {},
      {
        headers: { [EXPECTED_ACCOUNT_HEADER]: replacement.profile!.userId },
      },
    );
    expect(matching.status).toBe(200);
    // Its response may arrive after a new cookie was installed by another tab.
    expect(matching.headers.getSetCookie()).toEqual([]);
    expect((await replacement.request("/api/identity/me")).status).toBe(401);
    expect((await original.request("/api/identity/me")).status).toBe(200);
  });
});
