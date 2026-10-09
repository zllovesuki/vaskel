import { readHttpFailure } from "@tests/helpers/http";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AdministrationOutcomeSchema,
  InvitesOutcomeSchema,
} from "@vaskel/contracts/administration";
import {
  DirectoryOutcomeSchema,
  MembersOutcomeSchema,
} from "@vaskel/contracts/resources";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import {
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import {
  applicationHarness,
  decodeApplicationResponse,
  messageCommand,
  type ApplicationClient,
} from "@tests/helpers/application-harness";
import { openOwnerDatabase } from "@/server/actors/shared/database";

async function directory(client: ApplicationClient, path: string) {
  const result = await decodeApplicationResponse(
    await client.request(path),
    DirectoryOutcomeSchema,
  );
  if (result.kind !== "directory") throw new Error(result.kind);
  return result;
}
async function admin(
  client: ApplicationClient,
  id: string,
  operation: string,
  command: unknown,
) {
  return decodeApplicationResponse(
    await client.request(`/api/servers/${id}/${operation}`, command),
    AdministrationOutcomeSchema,
  );
}
async function changed(
  client: ApplicationClient,
  id: string,
  operation: string,
  command: unknown,
) {
  const result = await admin(client, id, operation, command);
  if (result.kind !== "changed") throw new Error(result.kind);
  return result;
}
async function invites(client: ApplicationClient, id: string, after?: string) {
  const response = await client.request(
    `/api/servers/${id}/invites${after ? `?after=${after}` : ""}`,
  );
  expect(response.status).toBe(200);
  const result = await decodeApplicationResponse(
    response,
    InvitesOutcomeSchema,
  );
  if (result.kind !== "invites") throw new Error(result.kind);
  return result;
}
async function send(
  client: ApplicationClient,
  path: string,
  channelId: string,
) {
  const result = await decodeApplicationResponse(
    await client.request(`${path}/send`, messageCommand(channelId)),
    MessagingOutcomeSchema,
  );
  if (result.kind !== "accepted") throw new Error(result.kind);
  return result.receipt;
}

describe("circle administration HTTP and native transaction boundaries", () => {
  it("enforces owner-only invite metadata and settings, with creation policy and non-secret revocation", async () => {
    const h = applicationHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    expect((await directory(alice.member, first.path)).membersMayInvite).toBe(
      true,
    );
    const memberInvite = await h.invite(alice.member, first.owner.id, 2);
    const listed = await invites(operator, first.owner.id);
    const memberRow = listed.invites.find(
      (row) => row.creatorId === alice.registered.userId,
    )!;
    expect(memberRow).toMatchObject({ revoked: false, uses: 0, maxUses: 2 });
    expect(memberRow.createdAt).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toContain(memberInvite.token);
    expect(memberRow).not.toHaveProperty("token");
    for (const client of [alice.member, bob.member]) {
      const response = await client.request(
        `/api/servers/${first.owner.id}/invites`,
      );
      expect(response.status).toBe(403);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        admin(client, first.owner.id, "settings", {
          membersMayInvite: false,
          expectedVersion: alice.joined.version,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const promoted = await changed(operator, first.owner.id, "set-role", {
      userId: alice.registered.userId,
      role: "moderator",
      expectedVersion: alice.joined.version,
    });
    const policy = await changed(operator, first.owner.id, "settings", {
      membersMayInvite: false,
      expectedVersion: promoted.version,
    });
    expect((await directory(alice.member, first.path)).membersMayInvite).toBe(
      false,
    );
    await expect(
      admin(operator, first.owner.id, "settings", {
        membersMayInvite: true,
        expectedVersion: promoted.version,
      }),
    ).rejects.toMatchObject({
      code: "STALE_VERSION",
      data: { kind: "stale_version", currentVersion: policy.version },
    });
    await expect(
      admin(alice.member, first.owner.id, "invites", {
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.invite(operator, first.owner.id);
    // The flag controls new invitations; existing invitation acceptance is unchanged.
    expect(
      await decodeApplicationResponse(
        await bob.member.request("/api/invites/join", {
          token: memberInvite.token,
        }),
        AdministrationOutcomeSchema,
      ),
    ).toMatchObject({ kind: "joined" });
    expect(
      (await invites(operator, first.owner.id)).invites.find(
        (row) => row.tokenHash === memberRow.tokenHash,
      )?.uses,
    ).toBe(1);
    await expect(
      admin(bob.member, first.owner.id, "revoke-invite", {
        tokenHash: memberRow.tokenHash,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await changed(alice.member, first.owner.id, "revoke-invite", {
      tokenHash: memberRow.tokenHash,
    });
    expect(
      (await invites(operator, first.owner.id)).invites.find(
        (row) => row.tokenHash === memberRow.tokenHash,
      )?.revoked,
    ).toBe(true);
    expect(
      await readHttpFailure(
        await h.anonymous.request("/api/invites/inspect", {
          token: memberInvite.token,
        }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    await expect(
      admin(operator, first.owner.id, "revoke-invite", {
        tokenHash: "bad",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const resources = await decodeApplicationResponse(
      await alice.member.request("/api/directory"),
      ResourceDirectorySchema,
    );
    expect(resources).toMatchObject({
      kind: "directory",
      resources: [{ role: "moderator", membersMayInvite: false }],
    });
  });

  it("paginates expired and revoked invitations without exposing tokens or widening access", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const stub = h.environment.SERVER_DO.getByName(server.owner.id);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let index = 0; index < 103; index++)
          state.storage.sql.exec(
            "INSERT INTO invites(token_hash,creator_id,expires_at,max_uses,uses,revoked,created_at) VALUES (?, ?, 1, 1, 0, ?, 0)",
            index.toString(16).padStart(64, "0"),
            operator.profile!.userId,
            index % 2,
          );
      });
    });
    const first = await invites(operator, server.owner.id);
    expect(first.invites).toHaveLength(100);
    expect(first.nextCursor).toBe(first.invites.at(-1)!.tokenHash);
    const second = await invites(operator, server.owner.id, first.nextCursor!);
    expect(second.invites).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.invites, ...second.invites].map((row) => row.tokenHash))
        .size,
    ).toBe(103);
    const malformed = await operator.request(
      `/api/servers/${server.owner.id}/invites?after=invalid`,
    );
    expect(malformed.status).toBe(400);
    await malformed.text();
  });

  it("limits moderator power to deleting readable circle messages, with immediate demotion enforcement", async () => {
    const h = applicationHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    const publicMessage = await send(operator, first.path, first.channelId);
    const deleteCommand = {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      channelId: first.channelId,
      messageId: publicMessage.messageId,
      expectedVersion: 1,
    };
    const before = await alice.member.request(
      `${first.path}/delete`,
      deleteCommand,
    );
    expect(before.status).toBe(403);
    await before.text();
    const promoted = await changed(operator, first.owner.id, "set-role", {
      userId: alice.registered.userId,
      role: "moderator",
      expectedVersion: alice.joined.version,
    });
    expect((await directory(alice.member, first.path)).role).toBe("moderator");
    expect(
      await decodeApplicationResponse(
        await operator.request(`${first.path}/members`),
        MembersOutcomeSchema,
      ),
    ).toMatchObject({
      kind: "members",
      members: expect.arrayContaining([
        { userId: alice.registered.userId, role: "moderator" },
      ]),
    });
    const reaction = {
      channelId: first.channelId,
      issuedAt: Date.now(),
      commandId: crypto.randomUUID(),
      messageId: publicMessage.messageId,
      emoji: "👍",
      on: true,
    };
    const reacted = await alice.member.request(`${first.path}/react`, reaction);
    expect(reacted.status).toBe(200);
    expect(
      await decodeApplicationResponse(reacted, MessagingOutcomeSchema),
    ).toMatchObject({ kind: "accepted", receipt: { version: 1 } });
    const privateId = crypto.randomUUID();
    let version = (
      await changed(operator, first.owner.id, "channels", {
        channelId: privateId,
        name: "Private",
        private: true,
        expectedVersion: promoted.version,
      })
    ).version;
    const hidden = await send(operator, first.path, privateId);
    const hiddenDelete = {
      ...deleteCommand,
      commandId: crypto.randomUUID(),
      channelId: privateId,
      messageId: hidden.messageId,
    };
    const hiddenDeletion = await alice.member.request(
      `${first.path}/delete`,
      hiddenDelete,
    );
    expect(hiddenDeletion.status).toBe(403);
    expect(await readHttpFailure(hiddenDeletion)).toMatchObject({
      code: "FORBIDDEN",
    });
    const hiddenReaction = await alice.member.request(`${first.path}/react`, {
      ...reaction,
      channelId: privateId,
      messageId: hidden.messageId,
      commandId: crypto.randomUUID(),
    });
    expect(hiddenReaction.status).toBe(403);
    expect(await readHttpFailure(hiddenReaction)).toMatchObject({
      code: "FORBIDDEN",
    });
    for (const [operation, command] of [
      [
        "set-role",
        {
          userId: bob.registered.userId,
          role: "moderator",
          expectedVersion: version,
        },
      ],
      [
        "remove-member",
        { userId: operator.profile!.userId, expectedVersion: version },
      ],
      ["settings", { membersMayInvite: false, expectedVersion: version }],
      [
        "transfer",
        { userId: alice.registered.userId, expectedVersion: version },
      ],
      [
        "channels",
        {
          channelId: crypto.randomUUID(),
          name: "Forbidden",
          private: false,
          expectedVersion: version,
        },
      ],
    ])
      await expect(
        admin(alice.member, first.owner.id, operation as string, command),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const edited = await alice.member.request(`${first.path}/edit`, {
      ...deleteCommand,
      commandId: crypto.randomUUID(),
      body: "Forged edit",
    });
    expect(edited.status).toBe(403);
    expect(await readHttpFailure(edited)).toMatchObject({ code: "FORBIDDEN" });
    const deletion = await alice.member.request(
      `${first.path}/delete`,
      deleteCommand,
    );
    expect(deletion.status).toBe(200);
    const deleted = await decodeApplicationResponse(
      deletion,
      MessagingOutcomeSchema,
    );
    expect(deleted).toMatchObject({
      kind: "accepted",
      receipt: { version: 2 },
    });
    const conversation = await decodeApplicationResponse(
      await alice.member.request("/api/conversations", {
        userId: operator.profile!.userId,
      }),
      ResourceCreatedSchema,
    );
    if (conversation.kind !== "created") throw new Error(conversation.kind);
    const conversationPath = `/api/resources/conversation/${conversation.owner.id}`;
    const directMessage = await send(
      operator,
      conversationPath,
      conversation.channelId,
    );
    expect(
      await readHttpFailure(
        await alice.member.request(`${conversationPath}/delete`, {
          ...deleteCommand,
          commandId: crypto.randomUUID(),
          channelId: conversation.channelId,
          messageId: directMessage.messageId,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await directory(alice.member, conversationPath)).not.toHaveProperty(
      "membersMayInvite",
    );
    // A moderator gains no private-room access from their role.
    await changed(operator, first.owner.id, "channel-member", {
      channelId: privateId,
      userId: alice.registered.userId,
      allowed: true,
      expectedVersion: 1,
    });
    version += 1;
    expect(
      (
        await decodeApplicationResponse(
          await alice.member.request(`${first.path}/delete`, hiddenDelete),
          MessagingOutcomeSchema,
        )
      ).kind,
    ).toBe("accepted");
    const next = await send(operator, first.path, first.channelId);
    await changed(operator, first.owner.id, "set-role", {
      userId: alice.registered.userId,
      role: "member",
      expectedVersion: version,
    });
    expect(
      await readHttpFailure(
        await alice.member.request(`${first.path}/delete`, {
          ...deleteCommand,
          commandId: crypto.randomUUID(),
          messageId: next.messageId,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    // Owners have the same readable-message deletion power, not author editing.
    const authored = await send(alice.member, first.path, first.channelId);
    expect(
      (
        await decodeApplicationResponse(
          await operator.request(`${first.path}/delete`, {
            ...deleteCommand,
            commandId: crypto.randomUUID(),
            messageId: authored.messageId,
          }),
          MessagingOutcomeSchema,
        )
      ).kind,
    ).toBe("accepted");
  });

  it("rolls back failed ownership swaps, resolves concurrent transfers once, and preserves immutable creation retries", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const alice = await h.registerMember(operator, server.owner.id);
    const bob = await h.registerMember(
      operator,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const stub = h.environment.SERVER_DO.getByName(server.owner.id);
    const expectedVersion = bob.joined.version;
    await expect(
      admin(alice.member, server.owner.id, "transfer", {
        userId: bob.registered.userId,
        expectedVersion,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      admin(operator, server.owner.id, "transfer", {
        userId: crypto.randomUUID(),
        expectedVersion,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      admin(operator, server.owner.id, "transfer", {
        userId: alice.registered.userId,
        expectedVersion: expectedVersion - 1,
      }),
    ).rejects.toMatchObject({
      code: "STALE_VERSION",
      data: { kind: "stale_version", currentVersion: expectedVersion },
    });
    await expect(
      admin(operator, server.owner.id, "set-role", {
        userId: operator.profile!.userId,
        role: "member",
        expectedVersion,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec(
        "CREATE TRIGGER reject_promotion BEFORE UPDATE OF role ON members WHEN NEW.role = 'owner' BEGIN SELECT RAISE(ABORT, 'fixture_promotion_failure'); END",
      ),
    );
    const failed = await operator.request(
      `/api/servers/${server.owner.id}/transfer`,
      { userId: alice.registered.userId, expectedVersion },
    );
    expect(failed.status).toBe(500);
    expect((await readHttpFailure(failed)).code).toBe("INTERNAL_SERVER_ERROR");
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT user_id FROM members WHERE role = 'owner'")
          .toArray(),
      ).toEqual([{ user_id: operator.profile!.userId }]);
      expect(
        state.storage.sql.exec("SELECT version FROM owner_state").one(),
      ).toEqual({ version: expectedVersion });
      state.storage.sql.exec("DROP TRIGGER reject_promotion");
    });
    const results = await Promise.allSettled(
      [alice.registered.userId, bob.registered.userId].map((userId) =>
        admin(operator, server.owner.id, "transfer", {
          userId,
          expectedVersion,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      {
        status: "fulfilled",
        value: { kind: "changed", version: expectedVersion + 1 },
      },
    ]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ code: "FORBIDDEN" }),
      },
    ]);
    const ownerId = await runInDurableObject(stub, (_instance, state) => {
      const owners = state.storage.sql
        .exec<{ user_id: string }>(
          "SELECT user_id FROM members WHERE role = 'owner'",
        )
        .toArray();
      expect(owners).toHaveLength(1);
      expect(() =>
        state.storage.sql.exec(
          "UPDATE members SET role = 'owner' WHERE user_id = ?",
          operator.profile!.userId,
        ),
      ).toThrow();
      return owners[0]!.user_id;
    });
    const newOwner =
      ownerId === alice.registered.userId ? alice.member : bob.member;
    expect((await directory(operator, server.path)).role).toBe("member");
    expect((await directory(newOwner, server.path)).role).toBe("owner");
    await expect(
      admin(operator, server.owner.id, "settings", {
        membersMayInvite: false,
        expectedVersion: expectedVersion + 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await changed(newOwner, server.owner.id, "settings", {
      membersMayInvite: false,
      expectedVersion: expectedVersion + 1,
    });
    expect(
      await decodeApplicationResponse(
        await operator.request("/api/servers", {
          commandId: server.commandId,
          name: server.name,
        }),
        ResourceCreatedSchema,
      ),
    ).toMatchObject({
      kind: "created",
      owner: server.owner,
      channelId: server.channelId,
    });
    expect((await directory(newOwner, server.path)).role).toBe("owner");
  });

  it("enforces moderator roles and one owner in the initial schema", async () => {
    const h = applicationHarness();
    const stub = h.environment.SERVER_DO.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      openOwnerDatabase(state.storage);
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES ('owner','owner'), ('member','member')",
      );
      state.storage.sql.exec(
        "UPDATE members SET role = 'moderator' WHERE user_id = 'member'",
      );
      expect(() =>
        state.storage.sql.exec(
          "UPDATE members SET role = 'other' WHERE user_id = 'member'",
        ),
      ).toThrow();
      expect(() =>
        state.storage.sql.exec(
          "UPDATE members SET role = 'owner' WHERE user_id = 'member'",
        ),
      ).toThrow();
    });
  });
});
