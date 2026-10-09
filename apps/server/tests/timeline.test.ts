import {
  messageEnvelope as envelope,
  acceptedMessage as accepted,
} from "@tests/helpers/messaging";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MessagingOutcomeSchema,
  REACTION_EMOJIS,
} from "@vaskel/contracts/messaging";
import type { Principal } from "@/server/domain/principal";

const principal = (userId = "alice"): Principal => ({
  userId,
  sessionId: userId,
  expiresAt: Date.now() + 60_000,
});

async function setup() {
  const id = crypto.randomUUID();
  const owner = env.CONVERSATION_DO.getByName(id);
  await owner.initialize({
    conversationId: id,
    participantIds: ["alice", "bob"],
  });
  const send = async (body: string) =>
    accepted(
      (await owner.send(principal(), { ...envelope(id), body })).outcome,
    );
  return { id, owner, send };
}

describe("timeline owner transaction boundaries", () => {
  it("derives mentions only from visible tokens as edits move them into and out of literal code", async () => {
    const h = await setup();
    const code =
      "`[](/mentions/bob)`\n```ts\n[](/mentions/bob)\n```\n[](/mentions/two words) [](/mentions/) [](/mentions/%ZZ) [](/mentions/outsider)";
    const sent = await h.send(code);
    const assertMentions = async (body: string, mentions: string[]) => {
      const original = await h.owner.originalMessage(principal("bob"), {
        channelId: h.id,
        messageId: sent.messageId,
      });
      expect(original).toMatchObject({
        kind: "original_message",
        message: { body, mentions },
      });
      const activity = await h.owner.activity(principal("bob"), {});
      expect(activity).toMatchObject({
        kind: "owner_activity",
        channels: [
          { channelId: h.id, unreadCount: 1, mentionCount: mentions.length },
        ],
      });
    };
    await assertMentions(code, []);
    let version = sent.version;
    for (const [body, mentions] of [
      [
        "Hello [](/mentions/bob) and [](/mentions/bob), with [](/mentions/outsider)",
        ["bob"],
      ],
      ["`[](/mentions/bob)`\n```\r\n[](/mentions/bob)\r\n```   ", []],
      ["A broken [ label [](/mentions/bob)", ["bob"]],
      ["```ts\n[](/mentions/bob)", []],
      ["```ts\n[](/mentions/bob)\n```", []],
      ["**[](/mentions/bob)**", ["bob"]],
      ["||[](/mentions/bob)||", ["bob"]],
      ["[](/mentions/bob\n)", ["bob"]],
      ["![](/mentions/bob) [name](/mentions/bob)", []],
      ["<div>[](/mentions/bob)</div>", []],
      ["[label][member]\n\n[member]: /mentions/bob", []],
    ] as const) {
      const edited = accepted(
        await h.owner.edit(principal(), {
          ...envelope(h.id),
          messageId: sent.messageId,
          expectedVersion: version,
          body,
        }),
      );
      version = edited.version;
      await assertMentions(body, [...mentions]);
    }
  });

  it("rolls back reaction and mention mutations with receipts, then recovers exact retries", async () => {
    const h = await setup();
    const sent = await h.send("Initial [](/mentions/bob)");
    const reaction = {
      ...envelope(h.id),
      messageId: sent.messageId,
      emoji: "👍" as const,
      on: true,
    };
    const edit = {
      ...envelope(h.id),
      messageId: sent.messageId,
      expectedVersion: 1,
      body: "Changed [](/mentions/alice)",
    };
    await runInDurableObject(h.owner, async (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_timeline AFTER INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'timeline failure'); END",
      );
    });
    await expect(
      (async () => await h.owner.react(principal("bob"), reaction))(),
    ).rejects.toThrow("timeline failure");
    await expect(
      (async () => await h.owner.edit(principal(), edit))(),
    ).rejects.toThrow("timeline failure");
    await expect(
      (async () =>
        (
          await h.owner.send(principal(), {
            ...envelope(h.id),
            body: "Rejected [](/mentions/bob)",
          })
        ).outcome)(),
    ).rejects.toThrow();
    const snapshot = await h.owner.snapshot(principal("bob"), {
      channelId: h.id,
    });
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      cursor: { sequence: 1 },
      messages: [
        {
          body: "Initial [](/mentions/bob)",
          mentions: ["bob"],
          reactions: [],
          version: 1,
        },
      ],
    });
    await runInDurableObject(h.owner, async (_, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_timeline");
    });
    const receipt = accepted(await h.owner.react(principal("bob"), reaction));
    const edited = accepted(await h.owner.edit(principal(), edit));
    expect(edited.version).toBe(2);
    expect(accepted(await h.owner.react(principal("bob"), reaction))).toEqual(
      receipt,
    );
    expect(
      await h.owner.snapshot(principal("bob"), { channelId: h.id }),
    ).toMatchObject({
      kind: "snapshot",
      messages: [
        {
          mentions: ["alice"],
          reactions: [{ count: 1, mine: true }],
          version: 2,
        },
      ],
    });
    accepted(
      await h.owner.deleteMessage(principal(), {
        ...envelope(h.id),
        messageId: sent.messageId,
        expectedVersion: 2,
      }),
    );
    expect(
      await h.owner.snapshot(principal("bob"), { channelId: h.id }),
    ).toMatchObject({
      kind: "snapshot",
      messages: [{ body: null, mentions: [], reactions: [] }],
    });
    await runInDurableObject(h.owner, async (_, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT (SELECT count(*) FROM reactions) + (SELECT count(*) FROM mentions) AS total",
          )
          .one(),
      ).toEqual({ total: 0 });
    });
  });

  it("bounds distinct emojis while concurrent reactions preserve edits and on/off state", async () => {
    const h = await setup();
    const sent = await h.send("Concurrent body");
    const react = (emoji: (typeof REACTION_EMOJIS)[number], on = true) => ({
      ...envelope(h.id),
      messageId: sent.messageId,
      emoji,
      on,
    });
    const [one, two, edit] = await Promise.all([
      h.owner.react(principal(), react("👍")),
      h.owner.react(principal("bob"), react("👍")),
      h.owner.edit(principal(), {
        ...envelope(h.id),
        messageId: sent.messageId,
        expectedVersion: 1,
        body: "Edited body",
      }),
    ]);
    expect([one, two, edit].map((result) => result.kind)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    for (const emoji of REACTION_EMOJIS.slice(1, 20))
      accepted(await h.owner.react(principal(), react(emoji)));
    expect(
      await h.owner.react(principal(), react(REACTION_EMOJIS[20]!)),
    ).toEqual({ kind: "capacity" });
    accepted(await h.owner.react(principal("bob"), react("👍")));
    const off = react("👍", false);
    const receipt = accepted(await h.owner.react(principal("bob"), off));
    expect(accepted(await h.owner.react(principal("bob"), off))).toEqual(
      receipt,
    );
    accepted(await h.owner.react(principal("bob"), react("👍", false)));
    const snapshot = await h.owner.snapshot(principal("bob"), {
      channelId: h.id,
    });
    if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
    expect(
      snapshot.messages[0]!.reactions.find((r) => r.emoji === "👍"),
    ).toEqual({ emoji: "👍", count: 1, mine: false });
    expect(snapshot.messages[0]!.version).toBe(2);
  });

  it("centers indexed history at both edges, keeps read/generation scope and excludes mutations from positions", async () => {
    const h = await setup();
    const sent = [];
    for (let i = 0; i < 7; i++) sent.push(await h.send(`Message ${i}`));
    await h.owner.react(principal("bob"), {
      ...envelope(h.id),
      messageId: sent[3]!.messageId,
      emoji: "👍",
      on: true,
    });
    await h.owner.updateRead(principal("bob"), {
      channelId: h.id,
      sequence: 3,
    });
    for (const [sequence, positions, nextBefore, nextAfter] of [
      [1, [1, 2, 3], null, 3],
      [4, [3, 4, 5], 3, 5],
      [7, [5, 6, 7], 5, null],
    ] as const) {
      const result = MessagingOutcomeSchema.parse(
        await h.owner.around(principal("bob"), {
          channelId: h.id,
          sequence,
          limit: 3,
        }),
      );
      if (result.kind !== "around") throw new Error(result.kind);
      expect(result.messages.map((message) => message.createdSequence)).toEqual(
        positions,
      );
      expect(result).toMatchObject({
        nextBefore,
        nextAfter,
        readSequence: 3,
        cursor: { channelId: h.id, sequence: 8 },
      });
    }
    expect(
      await h.owner.around(principal("bob"), { channelId: h.id, sequence: 8 }),
    ).toEqual({ kind: "not_found" });
    expect(
      await h.owner.around(principal("mallory"), {
        channelId: h.id,
        sequence: 4,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await h.owner.around(principal(), {
        channelId: "different",
        sequence: 4,
      }),
    ).toEqual({ kind: "not_found" });
    const full = await h.owner.around(principal(), {
      channelId: h.id,
      sequence: 4,
    });
    expect(full).toMatchObject({
      kind: "around",
      nextBefore: null,
      nextAfter: null,
    });
    const single = await h.owner.around(principal(), {
      channelId: h.id,
      sequence: 4,
      limit: 1,
    });
    expect(single).toMatchObject({
      kind: "around",
      messages: [{ createdSequence: 4 }],
      nextBefore: 4,
      nextAfter: 4,
    });
  });
  it("derives at most twenty valid channel readers and caps unread mention counts", async () => {
    const id = crypto.randomUUID();
    const owner = env.SERVER_DO.getByName(id);
    await owner.initialize({
      serverId: id,
      name: "Mentions",
      ownerId: "alice",
    });
    const channelId = crypto.randomUUID();
    await owner.createChannel(principal(), {
      channelId,
      name: "Private",
      private: true,
      expectedVersion: 1,
    });
    await runInDurableObject(owner, async (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO members(user_id, role) VALUES ('outsider', 'member')",
      );
      for (let i = 0; i < 22; i++) {
        state.storage.sql.exec(
          "INSERT INTO members(user_id, role) VALUES (?, 'member')",
          `member${i}`,
        );
        state.storage.sql.exec(
          "INSERT INTO channel_members(channel_id, user_id) VALUES (?, ?)",
          channelId,
          `member${i}`,
        );
      }
    });
    const body =
      "[](/mentions/unknown) [](/mentions/outsider) " +
      Array.from({ length: 22 }, (_, i) => `[](/mentions/member${i})`).join(
        " ",
      ) +
      " [](/mentions/member0)";
    const sent = accepted(
      (await owner.send(principal(), { ...envelope(channelId), body })).outcome,
    );
    const original = await owner.originalMessage(principal(), {
      channelId,
      messageId: sent.messageId,
    });
    if (original.kind !== "original_message") throw new Error(original.kind);
    expect(original.message.body).toBe(body);
    expect(original.message.mentions).toHaveLength(20);
    expect(original.message.mentions).not.toContain("outsider");
    expect(original.message.mentions).not.toContain("member20");
    expect(
      await owner.around(principal("outsider"), {
        channelId,
        sequence: sent.sequence,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await owner.react(principal("outsider"), {
        ...envelope(channelId),
        messageId: sent.messageId,
        emoji: "👍",
        on: true,
      }),
    ).toEqual({ kind: "forbidden" });
    for (let i = 0; i < 100; i++)
      accepted(
        (
          await owner.send(principal(), {
            ...envelope(channelId),
            body: "[](/mentions/member0)",
          })
        ).outcome,
      );
    const activity = await owner.activity(principal("member0"), {});
    if (activity.kind !== "owner_activity") throw new Error(activity.kind);
    expect(
      activity.channels.find((channel) => channel.channelId === channelId),
    ).toMatchObject({ unreadCount: 100, mentionCount: 100 });
    await owner.updateRead(principal("member0"), {
      channelId,
      sequence: sent.sequence,
    });
    const edit = {
      ...envelope(channelId),
      messageId: sent.messageId,
      expectedVersion: 1,
      body: "[](/mentions/member0)",
    };
    await owner.edit(principal(), edit);
    const after = await owner.activity(principal("member0"), {});
    if (after.kind !== "owner_activity") throw new Error(after.kind);
    expect(
      after.channels.find((channel) => channel.channelId === channelId)!
        .mentionCount,
    ).toBe(100);
  });
});
