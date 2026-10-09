import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { ServerAdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { ResourceDirectorySchema } from "@vaskel/contracts/directory";
import {
  applicationHarness,
  decodeApplicationResponse,
  type ApplicationClient,
} from "@tests/helpers/application-harness";
import { openAccountEvents } from "@tests/helpers/event-dispatch-harness";

async function administration(client: ApplicationClient, id: string) {
  const response = await client.request(`/api/servers/${id}/administration`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const result = await decodeApplicationResponse(
    response,
    ServerAdministrationOutcomeSchema,
  );
  if (result.kind !== "administration") throw new Error(result.kind);
  return result;
}

describe("owner administration independent of private content access", () => {
  it("keeps private rooms manageable after transfer without granting their content or occupancy", async () => {
    const h = applicationHarness();
    const owner = await h.bootstrap();
    const server = await h.createServer(owner);
    const alice = await h.registerMember(owner, server.owner.id);
    const privateId = crypto.randomUUID();
    expect(
      (
        await owner.request(`/api/servers/${server.owner.id}/channels`, {
          channelId: privateId,
          name: "Private room",
          private: true,
          expectedVersion: alice.joined.version,
        })
      ).status,
    ).toBe(200);
    const before = await administration(owner, server.owner.id);
    expect(
      (
        await alice.member.request(
          `/api/servers/${server.owner.id}/administration`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await owner.request(`/api/servers/${server.owner.id}/transfer`, {
          userId: alice.registered.userId,
          expectedVersion: before.version,
        })
      ).status,
    ).toBe(200);
    expect(
      (await owner.request(`/api/servers/${server.owner.id}/administration`))
        .status,
    ).toBe(403);
    const next = await administration(alice.member, server.owner.id);
    const privateRoom = next.channels.find((room) => room.id === privateId)!;
    expect(privateRoom).toMatchObject({
      name: "Private room",
      private: true,
      version: 1,
    });
    expect(privateRoom).not.toHaveProperty("occupancy");
    const directory = await decodeApplicationResponse(
      await alice.member.request(server.path),
      DirectoryOutcomeSchema,
    );
    if (directory.kind !== "directory") throw new Error(directory.kind);
    expect(directory.channels.some((room) => room.id === privateId)).toBe(
      false,
    );
    expect(
      (
        await alice.member.request(`${server.path}/snapshot`, {
          channelId: privateId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await alice.member.request(
          `/api/servers/${server.owner.id}/update-channel`,
          {
            channelId: privateId,
            name: "Managed without reading",
            expectedVersion: privateRoom.version,
          },
        )
      ).status,
    ).toBe(200);
    for (const [allowed, expectedVersion, snapshotStatus] of [
      [true, 2, 200],
      [false, 3, 403],
    ] as const) {
      expect(
        (
          await alice.member.request(
            `/api/servers/${server.owner.id}/channel-member`,
            {
              channelId: privateId,
              userId: alice.registered.userId,
              allowed,
              expectedVersion,
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await alice.member.request(`${server.path}/snapshot`, {
            channelId: privateId,
          })
        ).status,
      ).toBe(snapshotStatus);
    }
    expect(
      (await administration(alice.member, server.owner.id)).channels.find(
        (room) => room.id === privateId,
      ),
    ).toMatchObject({
      name: "Managed without reading",
      version: 4,
    });
  });

  it("validates full room orders and rolls back or fences interrupted and competing reorders", async () => {
    const h = applicationHarness();
    const owner = await h.bootstrap();
    const server = await h.createServer(owner);
    const alice = await h.registerMember(owner, server.owner.id);
    const ids = [server.channelId, crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, channelId] of ids.slice(1).entries()) {
      expect(
        (
          await owner.request(`/api/servers/${server.owner.id}/channels`, {
            channelId,
            name: `Room ${index}`,
            private: index === 0,
            expectedVersion: alice.joined.version + index,
          })
        ).status,
      ).toBe(200);
    }
    const before = await administration(owner, server.owner.id);
    const endpoint = `/api/servers/${server.owner.id}/reorder-channels`;
    expect(
      (
        await alice.member.request(endpoint, {
          channelIds: ids,
          expectedVersion: before.version,
        })
      ).status,
    ).toBe(403);
    for (const channelIds of [
      ids.slice(1),
      [ids[0], ids[0], ids[2]],
      [ids[0], ids[1], crypto.randomUUID()],
    ]) {
      expect(
        (
          await owner.request(endpoint, {
            channelIds,
            expectedVersion: before.version,
          })
        ).status,
      ).toBe(400);
    }
    const stub = h.environment.SERVER_DO.getByName(server.owner.id);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_reorder BEFORE UPDATE OF position ON channels WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'reorder rollback proof'); END",
      );
    });
    const requested = [ids[2], ids[0], ids[1]];
    expect(
      (
        await owner.request(endpoint, {
          channelIds: requested,
          expectedVersion: before.version,
        })
      ).status,
    ).toBe(500);
    expect(await administration(owner, server.owner.id)).toEqual(before);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_reorder");
    });
    const alternatives = [requested, [ids[1], ids[0], ids[2]]];
    const results = await Promise.all(
      alternatives.map((channelIds) =>
        owner.request(endpoint, {
          channelIds,
          expectedVersion: before.version,
        }),
      ),
    );
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const after = await administration(owner, server.owner.id);
    expect(after.version).toBe(before.version + 1);
    expect(after.channels.map((room) => room.id)).toEqual(
      alternatives[results.findIndex((response) => response.status === 200)],
    );
    expect(after.channels.map((room) => room.position)).toEqual([0, 1, 2]);
  });

  it("charges only usable invitations while retaining used invitation history", async () => {
    const h = applicationHarness();
    const owner = await h.bootstrap();
    const server = await h.createServer(owner);
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(server.owner.id),
      (_instance, state) => {
        state.storage.transactionSync(() => {
          for (let i = 0; i < 100; i++) {
            state.storage.sql.exec(
              "INSERT INTO invites(token_hash,creator_id,expires_at,max_uses,uses,revoked,created_at) VALUES (?, ?, ?, 1, 1, 0, ?)",
              i.toString(16).padStart(64, "0"),
              owner.profile!.userId,
              Date.now() + 86400000,
              Date.now(),
            );
          }
        });
      },
    );
    const created = await h.invite(owner, server.owner.id);
    expect(created.kind).toBe("invite_created");
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(server.owner.id),
      (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM invites WHERE uses = max_uses",
            )
            .one().count,
        ).toBe(100);
      },
    );
  });

  it("projects effective invitation capability for host and circle policy in both directory surfaces", async () => {
    const h = applicationHarness();
    const owner = await h.bootstrap();
    const server = await h.createServer(owner);
    const alice = await h.registerMember(owner, server.owner.id);
    async function capability(client: ApplicationClient, expected: boolean) {
      const direct = await decodeApplicationResponse(
        await client.request(server.path),
        DirectoryOutcomeSchema,
      );
      expect(direct).toMatchObject({
        kind: "directory",
        canCreateInvite: expected,
      });
      const list = await decodeApplicationResponse(
        await client.request("/api/directory"),
        ResourceDirectorySchema,
      );
      if (list.kind !== "directory") throw new Error(list.kind);
      expect(
        list.resources.find((item) => item.owner.id === server.owner.id)
          ?.canCreateInvite,
      ).toBe(expected);
    }
    await capability(alice.member, true);
    const stream = await openAccountEvents(alice.member);
    try {
      const count = () =>
        stream.frames.filter(
          (frame) =>
            frame.type === "directory" && frame.owner.id === server.owner.id,
        ).length;
      const before = count();
      expect(
        (
          await owner.request("/api/operator/instance", {
            name: "vaskel.",
            invitePolicy: "owners",
          })
        ).status,
      ).toBe(200);
      await expect.poll(count).toBeGreaterThan(before);
    } finally {
      await stream.close();
    }
    await capability(alice.member, false);
    await capability(owner, true);
    expect(
      (
        await owner.request("/api/operator/instance", {
          name: "vaskel.",
          invitePolicy: "members",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await owner.request(`/api/servers/${server.owner.id}/settings`, {
          membersMayInvite: false,
          expectedVersion: (await administration(owner, server.owner.id))
            .version,
        })
      ).status,
    ).toBe(200);
    await capability(alice.member, false);
    await capability(owner, true);
  });
});
