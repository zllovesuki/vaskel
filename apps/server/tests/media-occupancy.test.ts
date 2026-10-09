import { readHttpFailure } from "@tests/helpers/http";
import { moderationTarget } from "@tests/helpers/media-room";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { observeSql, selectStatements } from "@tests/helpers/sql-observer";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { OccupancySchema } from "@vaskel/contracts/occupancy";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import { drainOccupancy } from "@/server/actors/media/occupancy";
import {
  openMediaDatabase,
  revision,
  type RoomRuntime,
} from "@/server/actors/media/store";
import { RealtimeClient } from "@/server/providers/realtime";
import {
  applicationHarness,
  decodeApplicationResponse,
} from "@tests/helpers/application-harness";
import { mediaRoomKey } from "@/server/media/authorization";
import { openAccountEvents } from "@tests/helpers/event-dispatch-harness";
import { mediaNetwork } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  publication,
  publishReady,
  request,
  setup,
  user,
} from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
afterEach(() => mediaNetwork.resetHandlers());
afterAll(() => mediaNetwork.disable());

async function fixture(isPrivate = false) {
  const s = setup();
  const owner = env.SERVER_DO.getByName(s.scope.owner.id);
  await owner.initialize({
    serverId: s.scope.owner.id,
    name: "Occupancy",
    ownerId: s.principal.userId,
  });
  expect(
    await owner.createChannel(s.principal, {
      channelId: s.scope.channelId,
      name: "Voice",
      kind: "media",
      private: isPrivate,
      expectedVersion: 1,
    }),
  ).toMatchObject({ kind: "changed" });
  return { ...s, owner };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function occupancy(s: Fixture) {
  const result = DirectoryOutcomeSchema.parse(
    await s.owner.directory(s.principal),
  );
  if (result.kind !== "directory") throw new Error("Directory unavailable");
  return result.channels.find((channel) => channel.id === s.scope.channelId)!
    .occupancy;
}
async function join(s: Fixture) {
  return joined(
    await s.account.join(
      s.principal,
      grant(s.principal, s.scope),
      request(s.scope),
    ),
  );
}
function runtime(ctx: DurableObjectState): RoomRuntime {
  return {
    ctx,
    env,
    db: openMediaDatabase(ctx.storage),
    provider: new RealtimeClient(env),
    inflight: new Map(),
  };
}
async function summary(s: Fixture) {
  return runInDurableObject(s.media, (_instance, state) =>
    OccupancySchema.parse(
      JSON.parse(
        state.storage.sql
          .exec<{ summary: string }>(
            "SELECT summary FROM media_occupancy WHERE id=1",
          )
          .one().summary,
      ),
    ),
  );
}

describe("durable owner-authorized voice occupancy", () => {
  it("does not turn private subscription completion into another call notice", async () => {
    const s = await fixture();
    const first = await join(s);
    const published = await publishReady(s, first.handle);
    const principal = user();
    const receiver = joined(
      await env.ACCOUNT_MEDIA.getByName(principal.userId).join(
        principal,
        grant(principal, s.scope),
        request(s.scope),
      ),
    );
    await runDurableObjectAlarm(s.media);
    const before = await summary(s);
    s.fake.remoteRequiresRenegotiation = false;
    const result = await s.media.subscribe(
      principal,
      grant(principal, s.scope),
      {
        handle: receiver.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: 0,
        publicationIds: published.publications.map((p) => p.id),
      },
    );
    expect(result).toMatchObject({
      kind: "completed",
      subscriptions: [{ publication: published.publications[0] }],
    });
    expect(await summary(s)).toEqual(before);
    await evictDurableObject(s.media);
    const heartbeat = MediaOutcomeSchema.parse(
      await s.media.heartbeat(principal, grant(principal, s.scope), {
        handle: receiver.handle,
      }),
    );
    if (heartbeat.kind !== "heartbeat") throw new Error(heartbeat.kind);
    expect(heartbeat.snapshot.revision).toBe(before.revision);
    expect(heartbeat.snapshot.participants).toHaveLength(2);
  });
  it("publishes active account IDs, preserves the call start across screen changes and eviction, and clears before failing cleanup", async () => {
    const s = await fixture();
    expect(await occupancy(s)).toBeNull();
    const accepted = await join(s);
    await runDurableObjectAlarm(s.media);
    await expect.poll(() => occupancy(s)).not.toBeNull();
    const initial = await occupancy(s);
    expect(initial).toMatchObject({
      participantIds: [s.principal.userId],
      sharingUserIds: [],
      startedAt: expect.any(Number),
    });
    const command = publication(accepted.handle, ["screen_video"]);
    const pending = await s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      command,
    );
    if (pending.kind !== "negotiation") throw new Error("Expected negotiation");
    await runDurableObjectAlarm(s.media);
    await expect
      .poll(async () => (await occupancy(s))?.sharingUserIds)
      .toEqual([]);
    await s.media.ack(s.principal, grant(s.principal, s.scope), {
      handle: accepted.handle,
      operationId: pending.operationId,
      expectedSessionVersion: pending.sessionVersion,
    });
    await evictDurableObject(s.media);
    await runDurableObjectAlarm(s.media);
    await expect
      .poll(async () => (await occupancy(s))?.sharingUserIds)
      .toEqual([s.principal.userId]);
    const sharing = await occupancy(s);
    expect(sharing).toMatchObject({
      participantIds: [s.principal.userId],
      sharingUserIds: [s.principal.userId],
      startedAt: initial!.startedAt,
    });
    expect(sharing!.revision).toBeGreaterThan(initial!.revision);
    const unpublish = await s.media.unpublish(
      s.principal,
      grant(s.principal, s.scope),
      {
        handle: accepted.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: pending.sessionVersion,
        sources: ["screen_video"],
      },
    );
    expect(unpublish.kind).toBe("completed");
    await runDurableObjectAlarm(s.media);
    await expect
      .poll(() => occupancy(s))
      .toMatchObject({
        sharingUserIds: [],
        startedAt: initial!.startedAt,
      });
    const next = publication(
      accepted.handle,
      ["screen_video"],
      pending.sessionVersion + 1,
    );
    const republished = await s.media.publish(
      s.principal,
      grant(s.principal, s.scope),
      next,
    );
    if (republished.kind !== "negotiation")
      throw new Error("Expected second negotiation");
    await s.media.ack(s.principal, grant(s.principal, s.scope), {
      handle: accepted.handle,
      operationId: republished.operationId,
      expectedSessionVersion: republished.sessionVersion,
    });
    s.fake.failClose = true;
    await s.account.leave(s.principal, {
      handle: accepted.handle,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    });
    await runDurableObjectAlarm(s.media);
    await expect.poll(() => occupancy(s)).toBeNull();
    expect((await summary(s)).revision).toBeGreaterThan(sharing!.revision);
  });

  it("publishes logical membership before provider setup and durably removes screen sharing when revoked", async () => {
    const s = await fixture();
    const accepted = await join(s);
    expect(s.fake.calls).toHaveLength(0);
    await runDurableObjectAlarm(s.media);
    await expect
      .poll(async () => (await occupancy(s))?.participantIds)
      .toEqual([s.principal.userId]);
    await publishReady(s, accepted.handle, ["screen_video"]);
    await runDurableObjectAlarm(s.media);
    await expect
      .poll(async () => (await occupancy(s))?.sharingUserIds)
      .toEqual([s.principal.userId]);
    const before = await occupancy(s);
    s.fake.failClose = true;
    const snap = await s.media.snapshot(
      s.principal,
      grant(s.principal, s.scope),
      { room: s.scope },
    );
    if (snap.kind !== "media_snapshot") throw new Error("Expected snapshot");
    await s.media.moderate(s.principal, grant(s.principal, s.scope), {
      room: s.scope,
      userId: s.principal.userId,
      action: "screen_revoke",
      enabled: true,
      commandId: crypto.randomUUID(),
      ...moderationTarget(snap.snapshot, s.principal.userId),
    });
    await runDurableObjectAlarm(s.media);
    // Failed provider cleanup marks the participant closing, so the public room is empty.
    await expect.poll(() => occupancy(s)).toBeNull();
    expect(await summary(s)).toMatchObject({
      participantIds: [],
      sharingUserIds: [],
      startedAt: null,
    });
    expect((await summary(s)).revision).toBeGreaterThan(before!.revision);
  });

  it("rolls visibility back with its intent, retries lost delivery and never acknowledges a newer coalesced revision", async () => {
    const s = await fixture();
    await join(s);
    const original = await summary(s);
    await runInDurableObject(s.media, async (_instance, state) => {
      const rt = runtime(state);
      await expect(
        state.storage.transaction(async () => {
          state.storage.sql.exec(
            "UPDATE media_participants SET status='closing'",
          );
          await revision(rt);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        state.storage.sql
          .exec<{ status: string }>("SELECT status FROM media_participants")
          .one().status,
      ).toBe("active");
      await state.storage.deleteAlarm();
      state.storage.sql.exec(
        "UPDATE media_occupancy SET next_attempt_at=0,lease_id=NULL,lease_expires_at=NULL",
      );
      await drainOccupancy(rt, async () => {
        throw new Error("lost response");
      });
      expect(
        state.storage.sql
          .exec<{ next_attempt_at: number }>(
            "SELECT next_attempt_at FROM media_occupancy",
          )
          .one().next_attempt_at,
      ).toBeGreaterThan(Date.now());
      state.storage.sql.exec("UPDATE media_occupancy SET next_attempt_at=0");
      await drainOccupancy(rt, async (old) => {
        await state.storage.transaction(async () => {
          state.storage.sql.exec(
            "UPDATE media_participants SET status='closing'",
          );
          await revision(rt);
        });
        return s.owner.applyMediaOccupancy(old);
      });
      const pending = state.storage.sql
        .exec<{ revision: number; next_attempt_at: number | null }>(
          "SELECT revision,next_attempt_at FROM media_occupancy",
        )
        .one();
      expect(pending.revision).toBeGreaterThan(original.revision);
      expect(pending.next_attempt_at).not.toBeNull();
      await drainOccupancy(rt);
    });
    await expect.poll(() => occupancy(s)).toBeNull();
    expect(
      await s.owner.applyMediaOccupancy({ room: s.scope, occupancy: original }),
    ).toEqual({ kind: "ignored" });
    const projected = await runInDurableObject(s.owner, (_instance, state) =>
      OccupancySchema.parse(
        JSON.parse(
          state.storage.sql
            .exec<{ summary: string }>(
              "SELECT summary FROM channel_occupancy WHERE channel_id=?",
              s.scope.channelId,
            )
            .one().summary,
        ),
      ),
    );
    // Cleanup may already have queued a later closing -> left call notice.
    expect(
      await s.owner.applyMediaOccupancy({
        room: s.scope,
        occupancy: projected,
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("keeps call start across overlapping participants and starts a new call only after the last departure", async () => {
    const s = await fixture();
    const first = await join(s);
    const initial = await summary(s);
    const secondUser = user();
    const account = env.ACCOUNT_MEDIA.getByName(secondUser.userId);
    const second = joined(
      await account.join(
        secondUser,
        grant(secondUser, s.scope),
        request(s.scope),
      ),
    );
    expect(await summary(s)).toMatchObject({ startedAt: initial.startedAt });
    await s.account.leave(s.principal, {
      handle: first.handle,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    });
    expect(await summary(s)).toMatchObject({
      participantIds: [secondUser.userId],
      startedAt: initial.startedAt,
    });
    const left = await account.leave(secondUser, {
      handle: second.handle,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    });
    if (left.kind !== "left") throw new Error("Expected departure");
    expect(await summary(s)).toMatchObject({
      participantIds: [],
      startedAt: null,
    });
    await account.join(
      secondUser,
      grant(secondUser, s.scope),
      request(s.scope, left.generation),
    );
    const next = await summary(s);
    expect(next.startedAt).toBeGreaterThanOrEqual(initial.startedAt!);
    expect(next.revision).toBeGreaterThan(initial.revision);
  });

  it("batches occupancy reads and authorizes each participant in each private channel", async () => {
    const s = await fixture();
    await runInDurableObject(s.owner, async (instance, state) => {
      const member = crypto.randomUUID();
      const outsider = crypto.randomUUID();
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES (?,'member')",
        member,
      );
      const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
      for (const [index, id] of ids.entries()) {
        state.storage.sql.exec(
          "INSERT INTO channels(id,name,private,version,kind) VALUES (?,?,?,1,'media')",
          id,
          `Room ${index}`,
          index % 2,
        );
        state.storage.sql.exec(
          "INSERT INTO channel_members(channel_id,user_id) VALUES (?,?)",
          id,
          s.principal.userId,
        );
        if (index % 3 === 0)
          state.storage.sql.exec(
            "INSERT INTO channel_members(channel_id,user_id) VALUES (?,?)",
            id,
            member,
          );
      }
      for (const count of [0, 1, 25]) {
        for (const id of ids.slice(0, count))
          state.storage.sql.exec(
            "INSERT OR REPLACE INTO channel_occupancy(channel_id,revision,summary) VALUES (?,1,?)",
            id,
            JSON.stringify({
              revision: 1,
              participantIds: [s.principal.userId, member, outsider],
              sharingUserIds: [member, outsider],
              startedAt: 1,
            }),
          );
        const measured = await observeSql(state.storage.sql, () =>
          instance.directory(s.principal),
        );
        const directory = DirectoryOutcomeSchema.parse(measured.value);
        if (directory.kind !== "directory") throw new Error(directory.kind);
        expect(selectStatements(measured.statements)).toHaveLength(
          3 + Math.ceil((count * 3) / 40),
        );
        expect(
          measured.statements.every(
            (statement) => statement.bindings.length <= 100,
          ),
        ).toBe(true);
        for (const [index, id] of ids.entries()) {
          const summary = directory.channels.find(
            (channel) => channel.id === id,
          )!.occupancy;
          if (index >= count) expect(summary).toBeNull();
          else {
            const memberAllowed = index % 2 === 0 || index % 3 === 0;
            expect(summary?.participantIds).toEqual([
              s.principal.userId,
              ...(memberAllowed ? [member] : []),
            ]);
            expect(summary?.sharingUserIds).toEqual(
              memberAllowed ? [member] : [],
            );
          }
        }
      }
    });
  });

  it("projects conversation calls only to their participants", async () => {
    const first = user(),
      second = user(),
      id = crypto.randomUUID();
    const owner = env.CONVERSATION_DO.getByName(id);
    await owner.initialize({
      conversationId: id,
      participantIds: [first.userId, second.userId],
    });
    const room = {
      owner: { kind: "conversation" as const, id },
      channelId: id,
    };
    const occupancy = {
      revision: 8,
      participantIds: [first.userId],
      sharingUserIds: [],
      startedAt: Date.now(),
    };
    expect(await owner.applyMediaOccupancy({ room, occupancy })).toMatchObject({
      kind: "applied",
    });
    const result = DirectoryOutcomeSchema.parse(await owner.directory(second));
    if (result.kind !== "directory")
      throw new Error("Expected conversation directory");
    expect(result.channels[0]!.occupancy).toEqual(occupancy);
    expect(await owner.directory(user())).toEqual({ kind: "forbidden" });
  });

  it("validates real HTTP directory and inbox occupancy through fake-SFU admission and departure", async () => {
    setup();
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator, "HTTP occupancy");
    const channelId = crypto.randomUUID();
    const response = await operator.request(
      `/api/servers/${server.owner.id}/channels`,
      {
        channelId,
        name: "Voice",
        kind: "media",
        private: false,
        expectedVersion: 1,
      },
    );
    expect(response.status).toBe(200);
    const scope = { owner: server.owner, channelId };
    const stream = await openAccountEvents(operator);
    try {
      const joinedResponse = await operator.request(
        "/api/media/join",
        request(scope),
      );
      expect(joinedResponse.status).toBe(200);
      const accepted = joined(await joinedResponse.json());
      const media = env.MEDIA_ROOM.getByName(mediaRoomKey(scope));
      await runDurableObjectAlarm(media);
      const read = async () => {
        const result = await decodeApplicationResponse(
          await operator.request(server.path),
          DirectoryOutcomeSchema,
        );
        if (result.kind !== "directory")
          throw new Error("Expected HTTP directory");
        return result.channels.find((channel) => channel.id === channelId)!
          .occupancy;
      };
      await expect
        .poll(async () => (await read())?.participantIds)
        .toEqual([operator.profile!.userId]);
      await stream.sync();
      const active = stream.frames
        .filter((frame) => frame.type === "occupancy")
        .at(-1);
      expect(active).toEqual({
        type: "occupancy",
        owner: server.owner,
        channelId,
      });
      const activeHintCount = stream.frames.filter(
        (frame) => frame.type === "occupancy",
      ).length;
      const publishing = MediaOutcomeSchema.parse(
        await (
          await operator.request(
            "/api/media/publish",
            publication(accepted.handle, ["microphone", "camera"]),
          )
        ).json(),
      );
      if (publishing.kind !== "negotiation") throw new Error(publishing.kind);
      const acknowledged = await operator.request("/api/media/ack", {
        handle: accepted.handle,
        operationId: publishing.operationId,
        expectedSessionVersion: publishing.sessionVersion,
      });
      expect(acknowledged.status).toBe(200);
      await acknowledged.text();
      // Committed publication notices survive room eviction before delivery.
      await evictDurableObject(media);
      await runDurableObjectAlarm(media);
      await expect
        .poll(
          () => stream.frames.filter((frame) => frame.type === "call").length,
        )
        .toBeGreaterThan(0);
      expect(
        stream.frames.filter((frame) => frame.type === "occupancy"),
      ).toHaveLength(activeHintCount);
      const heartbeat = MediaOutcomeSchema.parse(
        await (
          await operator.request("/api/media/heartbeat", {
            handle: accepted.handle,
          })
        ).json(),
      );
      if (heartbeat.kind !== "heartbeat") throw new Error(heartbeat.kind);
      expect(heartbeat.snapshot.participants[0]).toMatchObject({
        id: accepted.handle.participantId,
        generation: accepted.handle.accountGeneration,
        status: "active",
      });
      expect(
        heartbeat.snapshot.participants[0]!.publications.map(
          (p) => p.source,
        ).sort(),
      ).toEqual(["camera", "microphone"]);
      expect(JSON.stringify(heartbeat)).not.toContain(
        accepted.handle.deviceToken,
      );
      const callHints = stream.frames.filter(
        (frame) => frame.type === "call",
      ).length;
      const moderated = await operator.request("/api/media/moderate", {
        room: scope,
        userId: operator.profile!.userId,
        action: "mute",
        enabled: true,
        commandId: crypto.randomUUID(),
        ...moderationTarget(heartbeat.snapshot, operator.profile!.userId),
      });
      expect(moderated.status).toBe(200);
      await moderated.text();
      const conflict = await operator.request("/api/media/moderate", {
        room: scope,
        userId: operator.profile!.userId,
        action: "mute",
        enabled: false,
        commandId: crypto.randomUUID(),
        ...moderationTarget(heartbeat.snapshot, operator.profile!.userId),
      });
      expect(conflict.status).toBe(409);
      expect(await readHttpFailure(conflict)).toMatchObject({
        code: "MODERATION_CHANGED",
      });

      await runDurableObjectAlarm(media);
      await expect
        .poll(
          () => stream.frames.filter((frame) => frame.type === "call").length,
        )
        .toBeGreaterThan(callHints);
      const left = await operator.request("/api/media/leave", {
        handle: accepted.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      });
      expect(left.status).toBe(200);
      await left.text();
      await runDurableObjectAlarm(media);
      await expect.poll(read).toBeNull();
      await stream.sync();
      const empty = stream.frames
        .filter((frame) => frame.type === "occupancy")
        .at(-1);
      expect(empty).toEqual({
        type: "occupancy",
        owner: server.owner,
        channelId,
      });
      expect(
        stream.frames.filter((frame) => frame.type === "occupancy").length,
      ).toBeGreaterThan(activeHintCount);
    } finally {
      await stream.close();
    }
  });

  it("filters current private membership and rejects mismatched owners and text channels before stale cleanup arrives", async () => {
    const s = await fixture(true);
    const other = user();
    const invite = await s.owner.createInvite(
      { ...s.principal, invitePolicy: "members" },
      {
        expiresAt: Date.now() + 60_000,
      },
    );
    if (invite.kind !== "invite_created") throw new Error("Expected invite");
    await s.owner.redeemInvite(other, { token: invite.token });
    await s.owner.setChannelMember(s.principal, {
      channelId: s.scope.channelId,
      userId: other.userId,
      allowed: true,
      expectedVersion: 1,
    });
    const mirrored = {
      revision: 10,
      participantIds: [other.userId],
      sharingUserIds: [other.userId],
      startedAt: Date.now(),
    };
    expect(
      await s.owner.applyMediaOccupancy({ room: s.scope, occupancy: mirrored }),
    ).toMatchObject({ kind: "applied" });
    expect(await occupancy(s)).toEqual(mirrored);
    await s.owner.setChannelMember(s.principal, {
      channelId: s.scope.channelId,
      userId: other.userId,
      allowed: false,
      expectedVersion: 2,
    });
    await expect.poll(() => occupancy(s)).toBeNull();
    const hidden = DirectoryOutcomeSchema.parse(await s.owner.directory(other));
    if (hidden.kind !== "directory") throw new Error("Expected directory");
    expect(
      hidden.channels.some((channel) => channel.id === s.scope.channelId),
    ).toBe(false);
    expect(await s.owner.directory(user())).toEqual({ kind: "forbidden" });
    expect(
      await s.owner.applyMediaOccupancy({
        room: {
          ...s.scope,
          owner: { kind: "server", id: crypto.randomUUID() },
        },
        occupancy: mirrored,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await s.owner.applyMediaOccupancy({
        room: { ...s.scope, channelId: s.scope.owner.id },
        occupancy: mirrored,
      }),
    ).toEqual({ kind: "forbidden" });
  });
});
