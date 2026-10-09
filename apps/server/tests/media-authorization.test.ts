import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import type { Principal } from "@/server/domain/principal";
import { mediaRoomKey } from "@/server/media/authorization";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import {
  drainMediaInvalidations,
  queueMediaInvalidations,
  type MediaInvalidationRequest,
} from "@/server/actors/shared/media-invalidations";

function principal(
  userId: string,
  expiresAt = Date.now() + 60 * 60_000,
): Principal {
  return {
    userId,
    sessionId: `session-${userId}`,
    expiresAt,
  };
}
async function server() {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  expect(
    (
      await owner.initialize({
        serverId: id,
        name: "Media authorization",
        ownerId: "alice",
      })
    ).kind,
  ).toBe("initialized");
  const invite = await owner.createInvite(
    { ...principal("alice"), invitePolicy: "members" },
    {
      expiresAt: Date.now() + 60_000,
    },
  );
  if (invite.kind !== "invite_created")
    throw new Error("Fixture invitation failed.");
  expect(
    (await owner.redeemInvite(principal("bob"), { token: invite.token })).kind,
  ).toBe("joined");
  return { id, owner };
}
async function mediaChannel(
  owner: Awaited<ReturnType<typeof server>>["owner"],
  isPrivate = false,
) {
  const directory = await owner.directory(principal("alice"));
  if (directory.kind !== "directory")
    throw new Error("Fixture directory failed.");
  const id = crypto.randomUUID();
  const created = AdministrationOutcomeSchema.parse(
    await owner.createChannel(principal("alice"), {
      channelId: id,
      name: isPrivate ? "Private voice" : "Voice",
      kind: "media",
      private: isPrivate,
      expectedVersion: directory.version,
    }),
  );
  if (created.kind !== "changed")
    throw new Error("Fixture media channel failed.");
  return id;
}

describe("owner-authorized media on real SQLite Durable Objects", () => {
  it("gates server media by channel kind, current membership and private ACL with owner-only moderation", async () => {
    const { id, owner } = await server();
    expect(
      await owner.authorizeMedia(principal("alice"), { channelId: id }),
    ).toEqual({ kind: "forbidden" });
    const publicMedia = await mediaChannel(owner);
    const privateMedia = await mediaChannel(owner, true);
    const permitted = await owner.authorizeMedia(principal("bob"), {
      channelId: publicMedia,
    });
    if (permitted.kind !== "media_authorized")
      throw new Error("Fixture authorization failed.");
    const grant = permitted.authorization;
    expect(grant).toMatchObject({
      userId: "bob",
      sessionId: "session-bob",
      room: { owner: { kind: "server", id }, channelId: publicMedia },
      canJoin: true,
      canSpeak: true,
      canCamera: true,
      canScreen: true,
      canModerate: false,
    });
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
    expect(
      await owner.authorizeMedia(principal("operator-outside"), {
        channelId: publicMedia,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await owner.authorizeMedia(principal("bob"), { channelId: privateMedia }),
    ).toEqual({ kind: "forbidden" });
    const ownerGrant = await owner.authorizeMedia(principal("alice"), {
      channelId: privateMedia,
    });
    if (ownerGrant.kind !== "media_authorized")
      throw new Error("Fixture owner authorization failed.");
    expect(ownerGrant.authorization.canModerate).toBe(true);
    const allowed = await owner.setChannelMember(principal("alice"), {
      channelId: privateMedia,
      userId: "bob",
      allowed: true,
      expectedVersion: 1,
    });
    expect(allowed).toEqual({ kind: "changed", version: 2 });
    const nowAllowed = await owner.authorizeMedia(principal("bob"), {
      channelId: privateMedia,
    });
    if (nowAllowed.kind !== "media_authorized")
      throw new Error("Fixture private authorization failed.");
    expect(nowAllowed.authorization.permissionGeneration).toBeGreaterThan(
      grant.permissionGeneration,
    );
    const expiresAt = Date.now() + 5_000;
    const short = await owner.authorizeMedia(principal("bob", expiresAt), {
      channelId: publicMedia,
    });
    if (short.kind !== "media_authorized")
      throw new Error("Fixture short lease failed.");
    expect(short.authorization.expiresAt).toBe(expiresAt);
    expect(
      await owner.authorizeMedia(principal("bob", Date.now() - 1), {
        channelId: publicMedia,
      }),
    ).toEqual({ kind: "unauthenticated" });
    expect(
      await owner.authorizeMedia(principal("alice"), {
        channelId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "not_found" });
    await owner.setChannelMember(principal("alice"), {
      channelId: privateMedia,
      userId: "alice",
      allowed: false,
      expectedVersion: 2,
    });
    expect(
      await owner.authorizeMedia(principal("alice"), {
        channelId: privateMedia,
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("allows text-channel DM calls only to exact participants without a moderation bypass", async () => {
    const id = crypto.randomUUID();
    const owner = env.CONVERSATION_DO.getByName(id);
    await owner.initialize({
      conversationId: id,
      participantIds: ["alice", "bob"],
    });
    for (const userId of ["alice", "bob"]) {
      const permitted = await owner.authorizeMedia(principal(userId), {
        channelId: id,
      });
      if (permitted.kind !== "media_authorized")
        throw new Error("Fixture DM authorization failed.");
      expect(permitted.authorization).toMatchObject({
        room: { owner: { kind: "conversation", id }, channelId: id },
        canModerate: false,
      });
    }
    expect(
      await owner.authorizeMedia(principal("operator-outside"), {
        channelId: id,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await owner.authorizeMedia(principal("alice"), {
        channelId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "not_found" });
    expect(
      await owner.authorizeMedia(principal("alice", 0), { channelId: id }),
    ).toEqual({ kind: "unauthenticated" });
  });

  it("rolls back private permission removal, its outbox, generation and durable wakeup after a later SQL trigger failure", async () => {
    const { owner } = await server();
    const channelId = await mediaChannel(owner, true);
    await owner.setChannelMember(principal("alice"), {
      channelId,
      userId: "bob",
      allowed: true,
      expectedVersion: 1,
    });
    const initial = await owner.authorizeMedia(principal("bob"), { channelId });
    if (initial.kind !== "media_authorized")
      throw new Error("Fixture private grant failed.");
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_media_permission BEFORE UPDATE OF version ON owner_state BEGIN SELECT RAISE(ABORT, 'fixture_permission_failure'); END",
      );
    });
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        // The preceding join may already have scheduled directory repair.
        // A rejected permission change must preserve that existing wakeup.
        const alarm = await state.storage.getAlarm();
        await expect(
          instance.setChannelMember(principal("alice"), {
            channelId,
            userId: "bob",
            allowed: false,
            expectedVersion: 2,
          }),
        ).rejects.toThrow();
        expect(await state.storage.getAlarm()).toBe(alarm);
      }),
    );
    const retained = await owner.authorizeMedia(principal("bob"), {
      channelId,
    });
    if (retained.kind !== "media_authorized")
      throw new Error("Permission rollback lost access.");
    expect(retained.authorization.permissionGeneration).toBe(
      initial.authorization.permissionGeneration,
    );
    await runInDurableObject(owner, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM media_invalidations")
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec("SELECT version FROM channels WHERE id = ?", channelId)
          .one(),
      ).toEqual({ version: 2 });
      state.storage.sql.exec("DROP TRIGGER fail_media_permission");
    });
    // Hold incoming alarm events across pending-work assertions; mutations still
    // execute their own native transactions and post-commit notifications.
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        const removed = AdministrationOutcomeSchema.parse(
          await instance.setChannelMember(principal("alice"), {
            channelId,
            userId: "bob",
            allowed: false,
            expectedVersion: 2,
          }),
        );
        expect(removed).toEqual({
          kind: "changed",
          version: 3,
          mediaCleanup: "pending",
        });
        expect(
          await instance.authorizeMedia(principal("bob"), { channelId }),
        ).toEqual({ kind: "forbidden" });
        expect(
          state.storage.sql
            .exec("SELECT permission_generation FROM media_invalidations")
            .one(),
        ).toEqual({
          permission_generation: initial.authorization.permissionGeneration + 1,
        });
        expect(await state.storage.getAlarm()).not.toBeNull();
      }),
    );
  });

  it("commits only affected media-room invalidations on server removal and completes empty-room cleanup without SFU credentials", async () => {
    const { id, owner } = await server();
    const publicMedia = await mediaChannel(owner);
    const inaccessibleMedia = await mediaChannel(owner, true);
    const directory = await owner.directory(principal("alice"));
    if (directory.kind !== "directory")
      throw new Error("Fixture directory failed.");
    const before = await owner.authorizeMedia(principal("bob"), {
      channelId: publicMedia,
    });
    if (before.kind !== "media_authorized")
      throw new Error("Fixture member grant failed.");
    // The permission generation is independent of the directory version that
    // channel creation and joins advanced.
    const revokedGeneration = before.authorization.permissionGeneration + 1;
    expect(revokedGeneration).not.toBe(directory.version + 1);
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        const removed = AdministrationOutcomeSchema.parse(
          await instance.removeMember(principal("alice"), {
            userId: "bob",
            expectedVersion: directory.version,
          }),
        );
        if (removed.kind !== "changed")
          throw new Error("Fixture server removal failed.");
        expect(removed.mediaCleanup).toBe("pending");
        expect(
          await instance.authorizeMedia(principal("bob"), {
            channelId: publicMedia,
          }),
        ).toEqual({ kind: "forbidden" });
        expect(
          state.storage.sql
            .exec(
              "SELECT channel_id,user_id,permission_generation FROM media_invalidations",
            )
            .toArray(),
        ).toEqual([
          {
            channel_id: publicMedia,
            user_id: "bob",
            permission_generation: revokedGeneration,
          },
        ]);
        expect(
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM media_invalidations WHERE channel_id = ?",
              inaccessibleMedia,
            )
            .one(),
        ).toEqual({ count: 0 });
        expect(await state.storage.getAlarm()).not.toBeNull();
        await instance.alarm();
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_invalidations")
            .one(),
        ).toEqual({ count: 0 });
      }),
    );
    const room = {
      owner: { kind: "server" as const, id },
      channelId: publicMedia,
    };
    await runInDurableObject(
      env.MEDIA_ROOM.getByName(mediaRoomKey(room)),
      (_instance, state) =>
        expect(
          state.storage.sql
            .exec(
              "SELECT generation FROM media_permission_floors WHERE user_id = 'bob'",
            )
            .one(),
        ).toEqual({ generation: revokedGeneration }),
    );
  });

  it("retains lost-response invalidations with backoff across eviction and retries the same durable command", async () => {
    const { owner } = await server();
    const channelId = await mediaChannel(owner);
    const directory = await owner.directory(principal("alice"));
    if (directory.kind !== "directory")
      throw new Error("Fixture directory failed.");
    const received: MediaInvalidationRequest[] = [];
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        await instance.removeMember(principal("alice"), {
          userId: "bob",
          expectedVersion: directory.version,
        });
        await drainMediaInvalidations(
          state,
          openOwnerDatabase(state.storage),
          async (request) => {
            received.push(request);
            throw new Error(
              "Test-only lost room response after durable acceptance.",
            );
          },
        );
        const row = state.storage.sql
          .exec("SELECT attempts,next_attempt_at FROM media_invalidations")
          .one();
        expect(row.attempts).toBe(1);
        expect(Number(row.next_attempt_at)).toBeGreaterThan(Date.now());
        expect(await state.storage.getAlarm()).not.toBeNull();
        // Pause automatic delivery during eviction; the retry below explicitly releases it.
        await state.storage.setAlarm(Date.now() + 60_000);
      }),
    );
    await evictDurableObject(owner);
    await runInDurableObject(owner, (_instance, state) =>
      state.blockConcurrencyWhile(async () => {
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_invalidations")
            .one(),
        ).toEqual({ count: 1 });
        state.storage.sql.exec(
          "UPDATE media_invalidations SET next_attempt_at = 0",
        );
        await drainMediaInvalidations(
          state,
          openOwnerDatabase(state.storage),
          async (request) => {
            received.push(request);
            return { kind: "closed" };
          },
        );
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_invalidations")
            .one(),
        ).toEqual({ count: 0 });
      }),
    );
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    expect(received[0]?.room.channelId).toBe(channelId);
  });

  it("retains confirmed-pending cleanup and prevents a late acknowledgement from dropping a newer permission generation", async () => {
    const { owner } = await server();
    const channelId = await mediaChannel(owner);
    const directory = await owner.directory(principal("alice"));
    if (directory.kind !== "directory")
      throw new Error("Fixture directory failed.");
    const before = await owner.authorizeMedia(principal("bob"), { channelId });
    if (before.kind !== "media_authorized")
      throw new Error("Fixture member grant failed.");
    const revoked = before.authorization.permissionGeneration + 1;
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        await instance.removeMember(principal("alice"), {
          userId: "bob",
          expectedVersion: directory.version,
        });
        const database = openOwnerDatabase(state.storage);
        const deliveredGenerations: number[] = [];
        await drainMediaInvalidations(state, database, async (request) => {
          deliveredGenerations.push(request.permissionGeneration);
          return { kind: "cleanup_pending", generation: 1 };
        });
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_invalidations")
            .one(),
        ).toEqual({ count: 1 });
        state.storage.sql.exec(
          "UPDATE media_invalidations SET next_attempt_at = 0",
        );
        await drainMediaInvalidations(state, database, async (request) => {
          deliveredGenerations.push(request.permissionGeneration);
          await state.storage.transaction(async () => {
            await queueMediaInvalidations(
              state.storage,
              database,
              [channelId],
              "bob",
              request.permissionGeneration + 1,
            );
            state.storage.sql.exec(
              "UPDATE owner_state SET permission_version = ?",
              request.permissionGeneration + 1,
            );
          });
          return { kind: "closed" };
        });
        expect(deliveredGenerations).toEqual([revoked, revoked]);
        const newer = state.storage.sql
          .exec(
            "SELECT permission_generation,attempts FROM media_invalidations",
          )
          .one();
        expect(newer).toEqual({
          permission_generation: revoked + 1,
          attempts: 0,
        });
        expect(await state.storage.getAlarm()).not.toBeNull();
        await drainMediaInvalidations(state, database, async (request) => {
          expect(request.permissionGeneration).toBe(revoked + 1);
          return { kind: "closed" };
        });
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_invalidations")
            .one(),
        ).toEqual({ count: 0 });
      }),
    );
  });

  it("queues the channel cap through bounded SQL batches and drains only ten invalidations while waking remaining work", async () => {
    const { owner } = await server();
    let version = 2;
    const firstChannel = crypto.randomUUID();
    for (let index = 0; index < 99; index++) {
      const result = await owner.createChannel(principal("alice"), {
        channelId: index === 0 ? firstChannel : crypto.randomUUID(),
        name: `Voice ${index}`,
        kind: "media",
        private: false,
        expectedVersion: version,
      });
      if (result.kind !== "changed")
        throw new Error("Fixture channel-cap setup failed.");
      version = result.version;
    }
    const before = await owner.authorizeMedia(principal("bob"), {
      channelId: firstChannel,
    });
    if (before.kind !== "media_authorized")
      throw new Error("Fixture member grant failed.");
    let delivered = 0;
    await runInDurableObject(owner, (instance, state) =>
      state.blockConcurrencyWhile(async () => {
        const removed = await instance.removeMember(principal("alice"), {
          userId: "bob",
          expectedVersion: version,
        });
        if (removed.kind !== "changed")
          throw new Error("Fixture channel-cap removal failed.");
        expect(removed.mediaCleanup).toBe("pending");
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM media_invalidations")
            .one(),
        ).toEqual({ count: 99 });
        await drainMediaInvalidations(
          state,
          openOwnerDatabase(state.storage),
          async (request) => {
            expect(request.userIds).toEqual(["bob"]);
            expect(request.permissionGeneration).toBe(
              before.authorization.permissionGeneration + 1,
            );
            delivered += 1;
            return { kind: "cleanup_pending", generation: 1 };
          },
        );
        expect(
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM media_invalidations WHERE attempts = 0",
            )
            .one(),
        ).toEqual({ count: 89 });
        expect(
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS count FROM media_invalidations WHERE attempts = 1",
            )
            .one(),
        ).toEqual({ count: 10 });
        const alarm = await state.storage.getAlarm();
        if (alarm === null)
          throw new Error(
            "Channel-cap invalidations lost their durable wakeup.",
          );
        expect(alarm).toBeLessThanOrEqual(Date.now() + 100);
      }),
    );
    expect(delivered).toBe(10);
  });
});
