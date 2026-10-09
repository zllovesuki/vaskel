import { readHttpFailure } from "@tests/helpers/http";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityPageSchema,
  OwnerActivityOutcomeSchema,
} from "@vaskel/contracts/activity";
import { ResourceCreatedSchema } from "@vaskel/contracts/directory";
import { BlockOutcomeSchema } from "@vaskel/contracts/blocking";
import {
  attachmentHarness,
  messagingResult,
} from "@tests/helpers/attachment-harness";
import {
  applicationHarness,
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
  type ApplicationClient,
} from "@tests/helpers/application-harness";
import { blockCommand } from "@tests/helpers/blocking-harness";

async function activity(
  client: ApplicationClient,
  path = "/api/account/activity",
) {
  const response = await client.request(path);
  expect(response.status).toBe(200);
  const result = await decodeApplicationResponse(response, ActivityPageSchema);
  if (result.kind !== "activity") throw new Error(result.kind);
  return result;
}

async function ownerActivity(client: ApplicationClient, path: string) {
  const response = await client.request(path);
  expect(response.status).toBe(200);
  const result = await decodeApplicationResponse(
    response,
    OwnerActivityOutcomeSchema,
  );
  if (result.kind !== "owner_activity") throw new Error(result.kind);
  return result;
}

const orderedId = (index: number) =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

describe("private activity HTTP and native owner boundaries", () => {
  it("acknowledges repeated and older reads without writing an unchanged cursor", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const sent = await messagingResult(
      await operator.request(
        `${server.path}/send`,
        messageCommand(server.channelId, "Read once"),
      ),
    );
    if (sent.kind !== "accepted") throw new Error(sent.kind);
    const read = (sequence: number) =>
      operator.request(`${server.path}/read`, {
        channelId: server.channelId,
        sequence,
      });
    expect((await read(sent.receipt.sequence)).status).toBe(200);
    await runInDurableObject(
      env.SERVER_DO.getByName(server.owner.id),
      (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TRIGGER reject_unchanged_read BEFORE UPDATE ON read_cursors WHEN NEW.sequence <= OLD.sequence BEGIN SELECT RAISE(ABORT, 'unchanged_read_write'); END",
        );
      },
    );
    for (const sequence of [sent.receipt.sequence, 0]) {
      expect(await messagingResult(await read(sequence))).toEqual({
        kind: "read_updated",
        sequence: sent.receipt.sequence,
      });
    }
    const later = await messagingResult(
      await operator.request(
        `${server.path}/send`,
        messageCommand(server.channelId, "Read further"),
      ),
    );
    if (later.kind !== "accepted") throw new Error(later.kind);
    expect(await messagingResult(await read(later.receipt.sequence))).toEqual({
      kind: "read_updated",
      sequence: later.receipt.sequence,
    });
  });

  it("caps counts, lowers them after deletion and excludes own messages and tombstones beyond the shared read cursor", async () => {
    const h = applicationHarness();
    const alice = await h.bootstrap();
    const server = await h.createServer(alice);
    const { member: bob } = await h.registerMember(
      alice,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const second = await h.signIn(h.client(), "operator@example.invalid");
    const authorId = bob.profile!.userId;
    const readerId = alice.profile!.userId;
    const channelId = server.channelId;
    await runInDurableObject(
      env.SERVER_DO.getByName(server.owner.id),
      (_instance, state) => {
        for (let sequence = 1; sequence <= 107; sequence++)
          state.storage.sql.exec(
            `INSERT INTO messages(id, channel_id, author_id, body, version,
              created_sequence, updated_sequence, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)`,
            orderedId(sequence),
            channelId,
            sequence === 106 ? readerId : authorId,
            sequence === 107 ? null : "Unread fixture",
            sequence,
            sequence,
            sequence === 107 ? 1 : null,
          );
        state.storage.sql.exec("UPDATE owner_state SET high_water = 107");
      },
    );
    const path = `${server.path}/activity`;
    expect((await ownerActivity(alice, path)).channels[0]).toMatchObject({
      unreadCount: 100,
      hasUnread: true,
      lastCreatedSequence: 107,
      readSequence: 0,
    });
    expect((await ownerActivity(bob, path)).channels[0]?.unreadCount).toBe(1);
    for (let sequence = 1; sequence <= 6; sequence++) {
      const deleted = await messagingResult(
        await bob.request(`${server.path}/delete`, {
          channelId,
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
          messageId: orderedId(sequence),
          expectedVersion: 1,
        }),
      );
      expect(deleted.kind).toBe("accepted");
    }
    expect((await ownerActivity(alice, path)).channels[0]?.unreadCount).toBe(
      99,
    );
    expect(
      (await activity(second)).owners.find(
        (item) => item.owner.id === server.owner.id,
      )?.channels[0]?.unreadCount,
    ).toBe(99);
    for (const [sequence, unreadCount] of [
      [100, 5],
      [105, 0],
    ] as const) {
      await messagingResult(
        await alice.request(`${server.path}/read`, { channelId, sequence }),
      );
      expect((await ownerActivity(second, path)).channels[0]).toMatchObject({
        readSequence: sequence,
        lastCreatedSequence: 107,
        unreadCount,
        hasUnread: unreadCount > 0,
      });
    }
  });
  it("shares reads across two sessions only, while summaries, edits, deletion and blocking preserve creation-based unread state", async () => {
    const h = attachmentHarness();
    const alice = await h.bootstrap();
    const server = await h.createServer(alice);
    const { member: bob } = await h.registerMember(
      alice,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const second = await h.signIn(h.client(), "operator@example.invalid");
    const created = await decodeApplicationResponse(
      await alice.request("/api/conversations", {
        userId: bob.profile!.userId,
      }),
      ResourceCreatedSchema,
    );
    if (created.kind !== "created") throw new Error(created.kind);
    const path = resourcePath(created.owner);
    const sockets = await Promise.all(
      [alice, second, bob].map((client) =>
        h.socket(client, path, created.channelId),
      ),
    );
    try {
      const sent = await messagingResult(
        await bob.request(
          `${path}/send`,
          messageCommand(created.channelId, "private body never in activity"),
        ),
      );
      if (sent.kind !== "accepted") throw new Error(sent.kind);
      for (const socket of sockets)
        expect((await socket.next()).type).toBe("committed");
      const summary = await ownerActivity(alice, `${path}/activity`);
      expect(summary.channels).toEqual([
        {
          channelId: created.channelId,
          lastCreatedSequence: sent.receipt.sequence,
          readSequence: 0,
          unreadCount: 1,
          mentionCount: 0,
          hasUnread: true,
        },
      ]);
      expect(JSON.stringify(summary)).not.toContain("private body");
      expect(
        (await activity(second)).owners.find(
          (owner) => owner.owner.id === created.owner.id,
        ),
      ).toMatchObject({
        generation: summary.generation,
        channels: summary.channels,
      });
      await messagingResult(
        await alice.request(`${path}/snapshot`, {
          channelId: created.channelId,
        }),
      );
      const owner = env.CONVERSATION_DO.getByName(created.owner.id);
      expect(
        await runInDurableObject(owner, (_instance, state) =>
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM read_cursors")
            .one(),
        ),
      ).toEqual({ count: 0 });
      expect(
        (await ownerActivity(second, `${path}/activity`)).channels,
      ).toEqual(summary.channels);
      for (const sequence of [sent.receipt.sequence, 0]) {
        expect(
          await messagingResult(
            await alice.request(`${path}/read`, {
              channelId: created.channelId,
              sequence,
            }),
          ),
        ).toEqual({ kind: "read_updated", sequence: sent.receipt.sequence });
        for (const socket of sockets.slice(0, 2))
          expect(await socket.next()).toEqual({
            type: "read_updated",
            channelId: created.channelId,
            sequence: sent.receipt.sequence,
          });
      }
      expect(
        await readHttpFailure(
          await bob.request(`${path}/read`, {
            channelId: created.channelId,
            sequence: sent.receipt.sequence + 1,
          }),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      for (const [client, readSequence] of [
        [second, sent.receipt.sequence],
        [bob, 0],
      ] as const)
        expect(
          await messagingResult(
            await client.request(`${path}/snapshot`, {
              channelId: created.channelId,
            }),
          ),
        ).toMatchObject({ kind: "snapshot", readSequence });
      expect(
        (await ownerActivity(second, `${path}/activity`)).channels[0],
      ).toMatchObject({
        readSequence: sent.receipt.sequence,
        unreadCount: 0,
        hasUnread: false,
      });
      expect(
        (await ownerActivity(bob, `${path}/activity`)).channels[0],
      ).toMatchObject({ readSequence: 0, unreadCount: 0, hasUnread: false });
      const edited = await messagingResult(
        await bob.request(`${path}/edit`, {
          ...messageCommand(created.channelId, "changed content"),
          messageId: sent.receipt.messageId,
          expectedVersion: 1,
        }),
      );
      if (edited.kind !== "accepted") throw new Error(edited.kind);
      for (const socket of sockets)
        expect((await socket.next()).type).toBe("committed");
      await messagingResult(
        await bob.request(`${path}/delete`, {
          channelId: created.channelId,
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
          messageId: sent.receipt.messageId,
          expectedVersion: 2,
        }),
      );
      for (const socket of sockets)
        expect((await socket.next()).type).toBe("committed");
      // Bob's following commit frames act as a delivery barrier for private read events.
      expect(
        sockets[2]!.frames.some((frame) => frame.type === "read_updated"),
      ).toBe(false);
      expect(
        (await ownerActivity(second, `${path}/activity`)).channels[0],
      ).toEqual({
        ...summary.channels[0],
        readSequence: sent.receipt.sequence,
        unreadCount: 0,
        hasUnread: false,
      });
      expect((await ownerActivity(bob, `${path}/activity`)).channels).toEqual([
        { ...summary.channels[0], unreadCount: 0, hasUnread: false },
      ]);
      await expect(
        messagingResult(
          await alice.request(`${path}/read`, {
            channelId: created.channelId,
            sequence: edited.receipt.sequence,
          }),
          400,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const blocked = await decodeApplicationResponse(
        await alice.request(
          `/api/account/blocks/${bob.profile!.userId}`,
          blockCommand(),
          { method: "PUT" },
        ),
        BlockOutcomeSchema,
      );
      expect(blocked.kind).toBe("block_updated");
      for (const socket of sockets)
        expect((await socket.next()).type).toBe("dm_policy_changed");
      expect((await ownerActivity(bob, `${path}/activity`)).channels).toEqual([
        { ...summary.channels[0], unreadCount: 0, hasUnread: false },
      ]);
      await messagingResult(
        await bob.request(`${path}/read`, {
          channelId: created.channelId,
          sequence: sent.receipt.sequence,
        }),
      );
      expect(await sockets[2]!.next()).toMatchObject({ type: "read_updated" });
      expect(
        (await ownerActivity(bob, `${path}/activity`)).channels[0]?.hasUnread,
      ).toBe(false);
      expect((await h.anonymous.request("/api/account/activity")).status).toBe(
        401,
      );
      expect((await alice.request("/api/account/activity?after=")).status).toBe(
        400,
      );
    } finally {
      for (const socket of sockets) await socket.close();
    }
  });
  it("paginates authorized channel summaries and rechecks private access and owner membership on every read", async () => {
    const h = applicationHarness();
    const alice = await h.bootstrap();
    const server = await h.createServer(alice);
    const owner = env.SERVER_DO.getByName(server.owner.id);
    const userId = alice.profile!.userId;
    await runInDurableObject(owner, (_instance, state) => {
      for (let index = 0; index < 33; index++)
        state.storage.sql.exec(
          "INSERT INTO channels(id,name,private,version,kind) VALUES (?, ?, ?, 1, 'text')",
          orderedId(index),
          `Channel ${index}`,
          index === 0 ? 1 : 0,
        );
      state.storage.sql.exec(
        "INSERT INTO channel_members(channel_id,user_id) VALUES (?, ?)",
        orderedId(0),
        userId,
      );
      state.storage.sql.exec(
        "INSERT INTO channels(id,name,private,version,kind) VALUES (?, 'hidden', 1, 1, 'text')",
        orderedId(99),
      );
      for (const index of [0, 99])
        state.storage.sql.exec(
          `INSERT INTO messages(id, channel_id, author_id, body, version,
            created_sequence, updated_sequence, created_at, updated_at)
           VALUES (?, ?, 'another-member', 'Private unread', 1, 1, 1, 1, 1)`,
          orderedId(index),
          orderedId(index),
        );
    });
    const first = await ownerActivity(alice, `${server.path}/activity`);
    expect(first.channels).toHaveLength(32);
    expect(first.nextCursor).toBe(orderedId(31));
    expect(first.channels[0]).toEqual({
      channelId: orderedId(0),
      lastCreatedSequence: 1,
      readSequence: 0,
      unreadCount: 1,
      mentionCount: 0,
      hasUnread: true,
    });
    const aggregate = await activity(alice);
    expect(aggregate).toMatchObject({ partial: true, nextCursor: null });
    expect(aggregate.owners[0]?.nextCursor).toBe(first.nextCursor);
    const second = await ownerActivity(
      alice,
      `${server.path}/activity?after=${first.nextCursor}`,
    );
    expect(second.channels.map((channel) => channel.channelId)).toEqual([
      orderedId(32),
      server.channelId,
    ]);
    expect(second.nextCursor).toBeNull();
    const principal = {
      userId,
      sessionId: "fixture",
      expiresAt: Date.now() + 60_000,
    };
    expect(
      await owner.setChannelMember(principal, {
        channelId: orderedId(0),
        userId,
        allowed: false,
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "changed" });
    const revoked = await ownerActivity(alice, `${server.path}/activity`);
    expect(
      revoked.channels.some((channel) => channel.channelId === orderedId(0)),
    ).toBe(false);
    expect(
      revoked.channels.some((channel) => channel.channelId === orderedId(99)),
    ).toBe(false);
    await expect(
      messagingResult(
        await alice.request(`${server.path}/snapshot`, {
          channelId: orderedId(0),
        }),
        403,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await runInDurableObject(owner, (_instance, state) =>
      state.storage.sql.exec("DELETE FROM members WHERE user_id = ?", userId),
    );
    expect((await alice.request(`${server.path}/activity`)).status).toBe(403);
    expect(await activity(alice)).toEqual({
      kind: "activity",
      owners: [],
      unavailableOwners: [],
      partial: false,
      nextCursor: null,
    });
  });

  it("bounds candidate fanout, exposes unavailable owners and continues past stale membership hints with bookmark policy intact", async () => {
    const h = applicationHarness();
    const alice = await h.bootstrap();
    const userId = alice.profile!.userId;
    const ids = Array.from({ length: 17 }, (_, index) => orderedId(index));
    for (const [index, id] of ids.entries()) {
      await env.SERVER_DO.getByName(id).initialize({
        serverId: id,
        name: `Server ${index}`,
        ownerId: index === 2 ? "someone-else" : userId,
      });
    }
    await env.IDENTITY_DB.batch(
      ids.flatMap((id) => [
        env.IDENTITY_DB.prepare(
          "INSERT INTO resource_directory(id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?, 'server', 'Candidate', ?, 'ready', 'fixture', 0)",
        ).bind(id, userId),
        env.IDENTITY_DB.prepare(
          "INSERT INTO resource_membership_index(resource_id,user_id) VALUES (?, ?)",
        ).bind(id, userId),
      ]),
    );
    await runInDurableObject(
      env.SERVER_DO.getByName(ids[1]!),
      (_instance, state) => state.storage.sql.exec("DROP TABLE read_cursors"),
    );
    const freshDevice = await h.signIn(h.client(), "operator@example.invalid");
    expect(freshDevice.bookmark).toBeUndefined();
    const sessions = vi.spyOn(env.IDENTITY_DB, "withSession");
    try {
      const first = await activity(freshDevice);
      expect(sessions).toHaveBeenCalledWith("first-unconstrained");
      expect(first).toMatchObject({
        partial: true,
        nextCursor: ids[15],
        unavailableOwners: [{ kind: "server", id: ids[1] }],
      });
      expect(first.owners).toHaveLength(14);
      expect(first.owners.some((owner) => owner.owner.id === ids[2])).toBe(
        false,
      );
      expect(first.owners.some((owner) => owner.owner.id === ids[16])).toBe(
        false,
      );
      sessions.mockClear();
      const bookmark = "activity-consistency-floor";
      const response = await freshDevice.request(
        `/api/account/activity?after=${first.nextCursor}`,
        undefined,
        { bookmark },
      );
      expect(sessions).toHaveBeenCalledWith(bookmark);
      expect(
        await decodeApplicationResponse(response, ActivityPageSchema),
      ).toMatchObject({
        owners: [{ owner: { id: ids[16] } }],
        partial: false,
        nextCursor: null,
        unavailableOwners: [],
      });
    } finally {
      sessions.mockRestore();
    }
  });
});
