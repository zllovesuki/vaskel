import { readHttpFailure } from "@tests/helpers/http";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { InviteRegistrationResponseSchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import {
  applicationHarness,
  decodeApplicationResponse,
} from "@tests/helpers/application-harness";
import { testPassword } from "@tests/helpers/identity-harness";

async function fixture() {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  const server = await h.createServer(operator);
  const invitation = await h.invite(operator, server.owner.id);
  const registration = {
    token: invitation.token,
    registrationId: crypto.randomUUID(),
    email: "invitee@example.invalid",
    displayName: "Invitee",
    password: testPassword,
  };
  return { h, operator, server, registration };
}

describe("invitation registration recovery and reserved admission", () => {
  it.each(["expired", "revoked"] as const)(
    "recovers an accepted registration and pending mail after its invite authorization is %s",
    async (reason) => {
      const { h, server, registration } = await fixture();
      h.mailer.fail = true;
      const first = await decodeApplicationResponse(
        await h.anonymous.request("/api/invites/register", registration),
        InviteRegistrationResponseSchema,
      );
      if (!("status" in first) || first.status !== "registered")
        throw new Error("Registration failed");
      expect(first.mailDelivery).toBe("pending");
      await runInDurableObject(
        h.environment.SERVER_DO.getByName(server.owner.id),
        (_, state) => {
          if (reason === "expired")
            state.storage.sql.exec(
              "UPDATE registration_authorizations SET expires_at=0",
            );
          else state.storage.sql.exec("UPDATE invites SET revoked=1");
        },
      );
      h.mailer.fail = false;
      const retry = await decodeApplicationResponse(
        await h.anonymous.request("/api/invites/register", registration),
        InviteRegistrationResponseSchema,
      );
      expect(retry).toEqual({
        status: "registered",
        userId: first.userId,
        mailDelivery: "sent",
      });
      expect(
        await h.environment.IDENTITY_DB.prepare(
          "SELECT COUNT(*) FROM identity_registration",
        ).first("COUNT(*)"),
      ).toBe(1);
      expect(
        await h.environment.IDENTITY_DB.prepare(
          "SELECT COUNT(*) FROM identity_user",
        ).first("COUNT(*)"),
      ).toBe(2);
      expect(
        await h.environment.IDENTITY_DB.prepare(
          "SELECT COUNT(*) FROM identity_mail WHERE user_id=?",
        )
          .bind(first.userId)
          .first("COUNT(*)"),
      ).toBe(1);
      const conflict = await h.anonymous.request("/api/invites/register", {
        ...registration,
        displayName: "Changed",
      });
      expect(await readHttpFailure(conflict)).toMatchObject({
        code: "AUTHORIZATION_CONFLICT",
      });
      if (reason === "revoked") {
        const fresh = await h.anonymous.request("/api/invites/register", {
          ...registration,
          registrationId: crypto.randomUUID(),
          email: "new@example.invalid",
        });
        expect(fresh.status).toBe(404);
      }
      await h.verify(registration.email);
      const member = await h.signIn(h.client(), registration.email);
      // Receipt recovery grants identity only; current invitation policy still owns joining.
      if (reason === "revoked")
        expect(
          (
            await member.request("/api/invites/join", {
              token: registration.token,
            })
          ).status,
        ).toBe(404);
    },
  );

  it("lets a verified holder inspect and join their reserved one-use invite while other callers cannot use it", async () => {
    const { h, operator, server, registration } = await fixture();
    expect(
      (await h.anonymous.request("/api/invites/register", registration)).status,
    ).toBe(201);
    const inspect = (client = h.anonymous) =>
      client.request("/api/invites/inspect", { token: registration.token });
    expect((await inspect()).status).toBe(404);
    expect((await inspect(operator)).status).toBe(404);
    await h.verify(registration.email);
    const member = await h.signIn(h.client(), registration.email);
    const visible = await decodeApplicationResponse(
      await inspect(member),
      AdministrationOutcomeSchema,
    );
    expect(visible).toMatchObject({
      kind: "invite_valid",
      serverId: server.owner.id,
    });
    expect(
      (await member.request("/api/invites/join", { token: registration.token }))
        .status,
    ).toBe(200);
    expect((await inspect()).status).toBe(404);
  });
});
