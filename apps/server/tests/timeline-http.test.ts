import { readHttpFailure } from "@tests/helpers/http";
import { describe, expect, it } from "vitest";
import { OriginalMessageOutcomeSchema } from "@vaskel/contracts/messaging";
import { CrossSearchResponseSchema } from "@vaskel/contracts/search";
import { ActivityPageSchema } from "@vaskel/contracts/activity";
import {
  attachmentHarness,
  messagingResult,
} from "@tests/helpers/attachment-harness";
import {
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
} from "@tests/helpers/application-harness";

describe("timeline reactions and mentions through real HTTP and sockets", () => {
  it("projects mine per reader on every producer and keeps edit versions independent", async () => {
    const h = attachmentHarness();
    const { operator, first, alice, bob } = await h.twoServers();
    const path = resourcePath(first.owner);
    const sent = await messagingResult(
      await alice.member.request(
        `${path}/send`,
        messageCommand(
          first.channelId,
          `Timeline searchable [](/mentions/${operator.profile!.userId}) [](/mentions/${bob.registered.userId}) [](/mentions/${operator.profile!.userId})`,
        ),
      ),
    );
    if (sent.kind !== "accepted") throw new Error(sent.kind);
    const a = await h.socket(alice.member, path, first.channelId);
    const o = await h.socket(operator, path, first.channelId);
    try {
      const envelope = {
        channelId: first.channelId,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      };
      const react = {
        ...envelope,
        messageId: sent.receipt.messageId,
        emoji: "👍",
        on: true,
      };
      const result = await messagingResult(
        await operator.request(`${path}/react`, react),
      );
      if (result.kind !== "accepted") throw new Error(result.kind);
      expect(result.receipt.version).toBe(1);
      for (const [stream, mine] of [
        [a, false],
        [o, true],
      ] as const) {
        expect(await stream.next()).toMatchObject({
          type: "committed",
          event: {
            operation: "edit",
            message: {
              version: 1,
              reactions: [{ emoji: "👍", count: 1, mine }],
              mentions: [operator.profile!.userId],
            },
          },
        });
      }
      expect(
        await messagingResult(await operator.request(`${path}/react`, react)),
      ).toEqual(result);
      expect(
        await readHttpFailure(
          await operator.request(`${path}/react`, { ...react, on: false }),
        ),
      ).toMatchObject({ code: "COMMAND_CONFLICT" });
      expect(
        await readHttpFailure(await bob.member.request(`${path}/react`, react)),
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(
        await readHttpFailure(
          await operator.request(`${path}/react`, { ...react, emoji: "hello" }),
        ),
      ).toMatchObject({ code: "BAD_REQUEST" });
      for (const [client, mine] of [
        [operator, true],
        [alice.member, false],
      ] as const) {
        const expected = [{ emoji: "👍", count: 1, mine }];
        const snapshot = await messagingResult(
          await client.request(`${path}/snapshot`, {
            channelId: first.channelId,
          }),
        );
        if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
        expect(snapshot.messages[0]!.reactions).toEqual(expected);
        const around = await messagingResult(
          await client.request(`${path}/around`, {
            channelId: first.channelId,
            sequence: sent.receipt.sequence,
            limit: 3,
          }),
        );
        expect(around).toMatchObject({
          kind: "around",
          messages: [{ reactions: expected }],
          nextBefore: null,
          nextAfter: null,
          cursor: snapshot.cursor,
        });
        const replay = await messagingResult(
          await client.request(`${path}/replay`, {
            channelId: first.channelId,
            cursor: { ...snapshot.cursor, sequence: 0 },
          }),
        );
        if (replay.kind !== "replay") throw new Error(replay.kind);
        expect(
          replay.events.every(
            (event) => event.message.reactions[0]!.mine === mine,
          ),
        ).toBe(true);
        const search = await messagingResult(
          await client.request(`${path}/search`, {
            channelId: first.channelId,
            query: "searchable",
          }),
        );
        if (search.kind !== "matches") throw new Error(search.kind);
        expect(search.messages[0]!.reactions).toEqual(expected);
        const original = await decodeApplicationResponse(
          await client.request(`${path}/original-message`, {
            channelId: first.channelId,
            messageId: sent.receipt.messageId,
          }),
          OriginalMessageOutcomeSchema,
        );
        expect(original).toMatchObject({
          kind: "original_message",
          message: { reactions: expected },
        });
        const cross = await decodeApplicationResponse(
          await client.request("/api/account/search", {
            query: "searchable",
            serverId: first.owner.id,
          }),
          CrossSearchResponseSchema,
        );
        expect(cross).toMatchObject({
          kind: "cross_matches",
          hits: [{ message: { reactions: expected } }],
        });
      }
      const edit = {
        ...envelope,
        commandId: crypto.randomUUID(),
        messageId: sent.receipt.messageId,
        expectedVersion: 1,
        body: "Updated searchable",
      };
      expect(
        await messagingResult(await alice.member.request(`${path}/edit`, edit)),
      ).toMatchObject({ kind: "accepted", receipt: { version: 2 } });
      const deleted = await messagingResult(
        await alice.member.request(`${path}/delete`, {
          ...envelope,
          commandId: crypto.randomUUID(),
          messageId: sent.receipt.messageId,
          expectedVersion: 2,
        }),
      );
      expect(deleted.kind).toBe("accepted");
      const tombstones = await messagingResult(
        await operator.request(`${path}/snapshot`, {
          channelId: first.channelId,
        }),
      );
      expect(tombstones).toMatchObject({
        kind: "snapshot",
        messages: [{ body: null, reactions: [], mentions: [] }],
      });
    } finally {
      await a.close();
      await o.close();
    }
  });

  it("counts validated mentions once and never reopens a read arrival after edits", async () => {
    const h = attachmentHarness();
    const { operator, first, alice } = await h.twoServers();
    const path = resourcePath(first.owner);
    const body = `Mention [](/mentions/${operator.profile!.userId}) [](/mentions/${operator.profile!.userId}) [](/mentions/unknown)`;
    const command = messageCommand(first.channelId, body);
    const sent = await messagingResult(
      await alice.member.request(`${path}/send`, command),
    );
    if (sent.kind !== "accepted") throw new Error(sent.kind);
    await messagingResult(await alice.member.request(`${path}/send`, command));
    async function counts() {
      const result = await decodeApplicationResponse(
        await operator.request("/api/account/activity"),
        ActivityPageSchema,
      );
      if (result.kind !== "activity") throw new Error(result.kind);
      return result.owners
        .find((owner) => owner.owner.id === first.owner.id)!
        .channels.find((channel) => channel.channelId === first.channelId)!;
    }
    expect(await counts()).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    await messagingResult(
      await operator.request(`${path}/read`, {
        channelId: first.channelId,
        sequence: sent.receipt.sequence,
      }),
    );
    const envelope = {
      channelId: first.channelId,
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
    };
    for (const [expectedVersion, updatedBody] of [
      [1, "Mention removed"],
      [2, body],
    ] as const) {
      await messagingResult(
        await alice.member.request(`${path}/edit`, {
          ...envelope,
          commandId: crypto.randomUUID(),
          messageId: sent.receipt.messageId,
          expectedVersion,
          body: updatedBody,
        }),
      );
      expect(await counts()).toMatchObject({ unreadCount: 0, mentionCount: 0 });
    }
  });
});
