import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  principal,
  alice,
  bob,
  carol,
  server,
} from "@tests/helpers/messaging-owner";

describe("authoritative invitation capacity and registration reservations", () => {
  it("enforces single use, duplicate acceptance, bound registration receipts and reservation expiry", async () => {
    const { id, owner } = await server();
    const invitation = await owner.createInvite(
      { ...alice(), invitePolicy: "members" },
      {
        expiresAt: Date.now() + 60 * 60 * 1_000,
      },
    );
    if (invitation.kind !== "invite_created")
      throw new Error("Expected invite");
    const registration = {
      token: invitation.token,
      registrationId: crypto.randomUUID(),
      userId: "bob",
    };
    const authorization = await owner.authorizeRegistration(registration);
    expect(authorization).toMatchObject({
      kind: "registration_authorized",
      authorizationId: registration.registrationId,
    });
    expect(await owner.authorizeRegistration(registration)).toEqual(
      authorization,
    );
    expect(
      await owner.authorizeRegistration({ ...registration, userId: "carol" }),
    ).toEqual({ kind: "command_conflict" });
    expect(
      await owner.authorizeRegistration({
        ...registration,
        registrationId: crypto.randomUUID(),
        userId: "carol",
      }),
    ).toEqual({ kind: "not_found" });
    expect(
      await owner.redeemInvite(carol(), { token: invitation.token }),
    ).toEqual({ kind: "not_found" });
    expect(await owner.snapshot(bob(), { channelId: id })).toEqual({
      kind: "forbidden",
    });
    expect(
      await owner.redeemInvite(bob(), { token: invitation.token }),
    ).toMatchObject({ kind: "joined", serverId: id });
    expect(
      await owner.redeemInvite(bob(), { token: invitation.token }),
    ).toMatchObject({ kind: "joined", serverId: id });
    expect(
      await owner.redeemInvite(carol(), { token: invitation.token }),
    ).toEqual({ kind: "not_found" });
    expect(
      await owner.removeMember(alice(), { userId: "bob", expectedVersion: 2 }),
    ).toEqual({ kind: "changed", version: 3 });
    expect(
      await owner.redeemInvite(bob(), { token: invitation.token }),
    ).toEqual({ kind: "forbidden" });
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        JSON.stringify(
          state.storage.sql.exec("SELECT * FROM invites").toArray(),
        ),
      ).not.toContain(invitation.token);
      expect(state.storage.sql.exec("SELECT uses FROM invites").one()).toEqual({
        uses: 1,
      });
    });
  });

  it("serializes competing acceptances at the authoritative maximum use count", async () => {
    const { owner } = await server();
    const invitation = await owner.createInvite(
      { ...alice(), invitePolicy: "members" },
      {
        expiresAt: Date.now() + 60_000,
        maxUses: 3,
      },
    );
    if (invitation.kind !== "invite_created")
      throw new Error("Expected invite");
    const candidates = Array.from({ length: 8 }, (_, index) =>
      principal(`candidate-${index}`),
    );
    const results = await Promise.all(
      candidates.map((candidate) =>
        owner.redeemInvite(candidate, { token: invitation.token }),
      ),
    );
    expect(results.filter((result) => result.kind === "joined")).toHaveLength(
      3,
    );
    expect(
      results.filter((result) => result.kind === "not_found"),
    ).toHaveLength(5);
    for (const [index, result] of results.entries())
      if (result.kind === "joined")
        expect(
          await owner.redeemInvite(candidates[index]!, {
            token: invitation.token,
          }),
        ).toMatchObject({ kind: "joined" });
    await runInDurableObject(owner, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT uses FROM invites").one()).toEqual({
        uses: 3,
      });
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS count FROM members").one(),
      ).toEqual({ count: 4 });
    });
  });

  it("makes revoked, expired and wrong-owner invites unavailable, releases stale reservations", async () => {
    const first = await server();
    const second = await server();
    const invitation = await first.owner.createInvite(
      { ...alice(), invitePolicy: "members" },
      {
        expiresAt: Date.now() + 60 * 60 * 1_000,
      },
    );
    if (invitation.kind !== "invite_created")
      throw new Error("Expected invite");
    const registration = {
      token: invitation.token,
      registrationId: crypto.randomUUID(),
      userId: "bob",
    };
    expect(await first.owner.authorizeRegistration(registration)).toMatchObject(
      { kind: "registration_authorized" },
    );
    expect(
      await second.owner.inspectInvite({ token: invitation.token }),
    ).toEqual({ kind: "not_found" });
    await runInDurableObject(first.owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE registration_authorizations SET expires_at = 0",
      );
    });
    expect(await first.owner.authorizeRegistration(registration)).toEqual({
      kind: "command_expired",
    });
    expect(
      await first.owner.inspectInvite({ token: invitation.token }),
    ).toMatchObject({ kind: "invite_valid" });
    expect(
      await first.owner.revokeInvite(alice(), { token: invitation.token }),
    ).toMatchObject({ kind: "changed" });
    expect(
      await first.owner.inspectInvite({ token: invitation.token }),
    ).toEqual({ kind: "not_found" });
    expect(
      await first.owner.redeemInvite(bob(), { token: invitation.token }),
    ).toEqual({ kind: "not_found" });
    const expired = await first.owner.createInvite(
      { ...alice(), invitePolicy: "members" },
      {
        expiresAt: Date.now() + 60_000,
      },
    );
    if (expired.kind !== "invite_created") throw new Error("Expected invite");
    await runInDurableObject(first.owner, (_instance, state) => {
      state.storage.sql.exec("UPDATE invites SET expires_at = 0");
    });
    expect(
      await first.owner.redeemInvite(bob(), { token: expired.token }),
    ).toEqual({ kind: "not_found" });
  });
});
