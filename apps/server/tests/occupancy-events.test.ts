import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { AccountEventFrameSchema } from "@vaskel/contracts/account-events";
import { notifyChannelHint } from "@/server/actors/shared/event-notices";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { applicationHarness } from "@tests/helpers/application-harness";
import { openAccountEvents } from "@tests/helpers/event-dispatch-harness";

function hints(stream: Awaited<ReturnType<typeof openAccountEvents>>) {
  return stream.frames.filter((frame) => frame.type === "occupancy");
}

describe("owner-authorized occupancy inbox producer", () => {
  it("sends reference-only hints to current private recipients while directory reads filter participants", async () => {
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
    const channelId = crypto.randomUUID();
    const before = DirectoryOutcomeSchema.parse(
      await (await operator.request(server.path)).json(),
    );
    if (before.kind !== "directory") throw new Error(before.kind);
    expect(
      (
        await operator.request(`/api/servers/${server.owner.id}/channels`, {
          channelId,
          name: "Private voice",
          kind: "media",
          private: true,
          expectedVersion: before.version,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await operator.request(
          `/api/servers/${server.owner.id}/channel-member`,
          {
            channelId,
            userId: alice.registered.userId,
            allowed: true,
            expectedVersion: 1,
          },
        )
      ).status,
    ).toBe(200);
    const owner = env.SERVER_DO.getByName(server.owner.id);
    const room = { owner: server.owner, channelId };
    const streams = await Promise.all([
      openAccountEvents(operator),
      openAccountEvents(alice.member),
      openAccountEvents(bob.member),
    ]);
    const [host, permitted, denied] = streams;
    const summary = {
      revision: 10,
      participantIds: [alice.registered.userId, bob.registered.userId],
      startedAt: Date.now(),
      sharingUserIds: [alice.registered.userId, bob.registered.userId],
    };
    const read = async () => {
      const directory = DirectoryOutcomeSchema.parse(
        await (await operator.request(server.path)).json(),
      );
      if (directory.kind !== "directory") throw new Error(directory.kind);
      return directory.channels.find((channel) => channel.id === channelId)!
        .occupancy;
    };
    try {
      expect(
        await owner.applyMediaOccupancy({ room, occupancy: summary }),
      ).toMatchObject({ kind: "applied" });
      await Promise.all(streams.map((stream) => stream.sync()));
      const visible = {
        ...summary,
        participantIds: [alice.registered.userId],
        sharingUserIds: [alice.registered.userId],
      };
      expect(await read()).toEqual(visible);
      for (const stream of [host!, permitted!])
        await expect
          .poll(() => hints(stream))
          .toEqual([{ type: "occupancy", ...room }]);
      expect(hints(denied!)).toHaveLength(0);
      expect(
        AccountEventFrameSchema.safeParse({
          ...hints(host!)[0],
          occupancy: visible,
        }).success,
      ).toBe(false);
      expect(
        await owner.applyMediaOccupancy({
          room,
          occupancy: { ...summary, revision: 9 },
        }),
      ).toEqual({ kind: "ignored" });
      expect(
        await owner.applyMediaOccupancy({ room, occupancy: summary }),
      ).toEqual({ kind: "ignored" });
      await Promise.all(streams.map((stream) => stream.sync()));
      expect(hints(host!)).toHaveLength(1);
      expect(hints(permitted!)).toHaveLength(1);
      // A camera/moderation-only change reaches the same authorized readers,
      // but does not ask every reader to refresh Home.
      expect(
        await owner.applyMediaOccupancy({
          room,
          occupancy: { ...summary, revision: 11 },
        }),
      ).toEqual({ kind: "applied", occupancyChanged: false });
      for (const stream of [host!, permitted!])
        await expect
          .poll(() => stream.frames.filter((frame) => frame.type === "call"))
          .toEqual([{ type: "call", ...room }]);
      expect(denied!.frames.some((frame) => frame.type === "call")).toBe(false);
      expect(hints(host!)).toHaveLength(1);

      expect(
        (
          await operator.request(
            `/api/servers/${server.owner.id}/channel-member`,
            {
              channelId,
              userId: alice.registered.userId,
              allowed: false,
              expectedVersion: 2,
            },
          )
        ).status,
      ).toBe(200);
      expect(await read()).toBeNull();
      // Delayed hints recheck recipient access; participant visibility belongs to the directory.
      await runInDurableObject(owner, (_instance, state) =>
        notifyChannelHint(state, env, openOwnerDatabase(state.storage), {
          type: "occupancy",
          ...room,
        }),
      );
      await Promise.all(streams.map((stream) => stream.sync()));
      await expect
        .poll(() => hints(host!).at(-1))
        .toEqual({
          type: "occupancy",
          ...room,
        });
      expect(hints(permitted!)).toHaveLength(1);
      expect(hints(denied!)).toHaveLength(0);
      expect(permitted!.frames).toContainEqual({
        type: "directory",
        owner: server.owner,
      });

      const empty = {
        revision: 12,
        participantIds: [],
        sharingUserIds: [],
        startedAt: null,
      };
      expect(
        await owner.applyMediaOccupancy({ room, occupancy: empty }),
      ).toMatchObject({ kind: "applied" });
      await host!.sync();
      await expect
        .poll(() => hints(host!).at(-1))
        .toEqual({
          type: "occupancy",
          ...room,
        });
      expect(await read()).toBeNull();
      const beforeDelayed = hints(host!).length;
      await runInDurableObject(owner, (_instance, state) =>
        notifyChannelHint(state, env, openOwnerDatabase(state.storage), {
          type: "occupancy",
          ...room,
        }),
      );
      await host!.sync();
      await expect
        .poll(() => hints(host!).length)
        .toBeGreaterThan(beforeDelayed);
      expect(hints(host!).at(-1)).toEqual({
        type: "occupancy",
        ...room,
      });
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });
});
