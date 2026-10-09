import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mutateMessage } from "@/server/actors/shared/messages";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { notifyCommit } from "@/server/actors/shared/event-notices";
import {
  attachmentHarness,
  messagingResult,
} from "@tests/helpers/attachment-harness";
import { messageCommand } from "@tests/helpers/application-harness";
import { openAccountEvents } from "@tests/helpers/event-dispatch-harness";
import { actorWork } from "@/server/actors/shared/bounded-work";
import { barrier } from "@tests/helpers/barrier";

const activity = (stream: Awaited<ReturnType<typeof openAccountEvents>>) =>
  stream.frames.filter((frame) => frame.type === "activity");

describe("timeline and reference-only inbox integration", () => {
  it("emits one activity reference per recipient while reactions retain private mine and edit predecessors", async () => {
    const h = attachmentHarness();
    const { operator, first, alice } = await h.twoServers();
    const bob = await h.registerMember(
      operator,
      first.owner.id,
      "reader@example.invalid",
      "Reader",
    );
    const streams = await Promise.all([
      openAccountEvents(alice.member),
      openAccountEvents(bob.member),
    ]);
    const rooms = await Promise.all([
      h.socket(alice.member, first.path, first.channelId),
      h.socket(bob.member, first.path, first.channelId),
    ]);
    try {
      const command = messageCommand(
        first.channelId,
        `Fresh [](/mentions/${alice.registered.userId})`,
      );
      const sent = await messagingResult(
        await operator.request(`${first.path}/send`, command),
      );
      if (sent.kind !== "accepted") throw new Error(sent.kind);
      expect(Object.keys(sent).sort()).toEqual(["kind", "receipt"]);
      for (const room of rooms) await room.next();
      await messagingResult(
        await operator.request(`${first.path}/send`, command),
      );
      for (const room of rooms) await room.next();
      await Promise.all(streams.map((stream) => stream.sync()));
      await expect
        .poll(() => activity(streams[0]!))
        .toMatchObject([{ sequence: sent.receipt.sequence }]);
      await expect
        .poll(() => activity(streams[1]!))
        .toMatchObject([{ sequence: sent.receipt.sequence }]);
      const base = {
        channelId: command.channelId,
        issuedAt: command.issuedAt,
      };
      const reacted = await messagingResult(
        await alice.member.request(`${first.path}/react`, {
          ...base,
          commandId: crypto.randomUUID(),
          messageId: sent.receipt.messageId,
          emoji: "👍",
          on: true,
        }),
      );
      if (reacted.kind !== "accepted") throw new Error(reacted.kind);
      for (const [index, room] of rooms.entries())
        expect(await room.next()).toMatchObject({
          type: "committed",
          previous: sent.receipt.sequence,
          event: {
            operation: "edit",
            message: {
              version: 1,
              reactions: [{ emoji: "👍", mine: index === 0, count: 1 }],
            },
          },
        });
      const edit = {
        ...messageCommand(
          first.channelId,
          `Edited [](/mentions/${bob.registered.userId})`,
        ),
        messageId: sent.receipt.messageId,
        expectedVersion: 1,
      };
      await messagingResult(await operator.request(`${first.path}/edit`, edit));
      await messagingResult(await operator.request(`${first.path}/edit`, edit));
      await Promise.all(streams.map((stream) => stream.sync()));
      for (const stream of streams) {
        await expect
          .poll(() =>
            stream.frames.filter((frame) => frame.type === "mutation"),
          )
          .toHaveLength(2);
        expect(activity(stream)).toHaveLength(1);
      }
    } finally {
      await Promise.all([...streams, ...rooms].map((stream) => stream.close()));
    }
  });

  it("rechecks current access for delayed activity hints after a message edit", async () => {
    const h = attachmentHarness();
    const { operator, first, alice } = await h.twoServers();
    const bob = await h.registerMember(
      operator,
      first.owner.id,
      "reader@example.invalid",
      "Reader",
    );
    const streams = await Promise.all([
      openAccountEvents(alice.member),
      openAccountEvents(bob.member),
    ]);
    const owner = env.SERVER_DO.getByName(first.owner.id);
    const command = messageCommand(
      first.channelId,
      `Initial [](/mentions/${alice.registered.userId})`,
    );
    try {
      const pending = await runInDurableObject(owner, (_, state) =>
        mutateMessage(
          state.storage,
          openOwnerDatabase(state.storage),
          {
            userId: operator.profile!.userId,
            sessionId: "integration",
            expiresAt: Date.now() + 60000,
          },
          { kind: "send", command },
          512 * 1024 * 1024,
        ),
      );
      if (pending.kind !== "committed") throw new Error(pending.kind);
      await messagingResult(
        await operator.request(`${first.path}/edit`, {
          ...messageCommand(
            first.channelId,
            `Changed [](/mentions/${bob.registered.userId})`,
          ),
          messageId: pending.receipt.messageId,
          expectedVersion: 1,
        }),
      );
      await runInDurableObject(owner, (_, state) =>
        notifyCommit(
          state,
          env,
          openOwnerDatabase(state.storage),
          pending.notice,
        ),
      );
      await Promise.all(streams.map((stream) => stream.sync()));
      // Addressing is fixed at send time: the later edit does not move it to Bob.
      const [aliceEvents, bobEvents] = streams;
      for (const [stream, direct] of [
        [aliceEvents, true],
        [bobEvents, false],
      ] as const)
        await expect
          .poll(() => activity(stream))
          .toEqual([
            {
              type: "activity",
              owner: first.owner,
              channelId: first.channelId,
              generation: pending.notice.generation,
              sequence: pending.receipt.sequence,
              direct,
            },
          ]);
      const gate = barrier();
      let occupied = false;
      const holding = runInDurableObject(owner, async (_, state) => {
        const work = actorWork(state.storage, "hints").map(
          Array.from({ length: 8 }),
          () => gate.promise,
        );
        occupied = true;
        await work;
      });
      try {
        await expect.poll(() => occupied).toBe(true);
        const candidates = await runInDurableObject(owner, (_, state) =>
          notifyCommit(
            state,
            env,
            openOwnerDatabase(state.storage),
            pending.notice,
          ),
        );
        expect(candidates).toContain(alice.registered.userId);
        // Access changes after selection, while the delivery batches still wait.
        await runInDurableObject(owner, (_, state) => {
          state.storage.sql.exec(
            "DELETE FROM members WHERE user_id=?",
            alice.registered.userId,
          );
        });
      } finally {
        gate.release();
        await holding;
      }
      await Promise.all(streams.map((stream) => stream.sync()));
      await expect.poll(() => activity(streams[1]!)).toHaveLength(2);
      expect(activity(streams[0]!)).toHaveLength(1);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });
});
