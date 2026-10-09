import { notificationOwner as setup } from "@tests/helpers/notification-owner";
import { principal } from "@tests/helpers/messaging-owner";
import type {
  NotificationMessageReference,
  NotificationEligibleMessage,
} from "@/server/notifications/protocol";
import {
  messageEnvelope as command,
  acceptedMessage as receipt,
} from "@tests/helpers/messaging";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { messageMarkdown } from "@vaskel/contracts/message-text";
import { observeSql, selectStatements } from "@tests/helpers/sql-observer";
import { notificationPayload } from "@/server/actors/notification/presentation";

function renderPreview(message: NotificationEligibleMessage) {
  return notificationPayload(
    "bob",
    { paused: false, preview: "message", language: "en" },
    message,
  ).body;
}

describe("trusted notification message source", () => {
  it("selects one requested winner without rendering or returning unrequested text", async ({
    onTestFinished,
  }) => {
    const h = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => {
      clock.mockRestore();
    });
    const references: NotificationMessageReference[] = [];
    for (let index = 0; index < 32; index++) {
      clock.mockReturnValue(now + index);
      references.push(
        await h.send(
          `Message ${index} ||secret||${index === 8 || index === 24 ? " [](/mentions/bob)" : ""}`,
        ),
      );
    }
    const parser = vi.spyOn(messageMarkdown, "parse");
    onTestFinished(() => {
      parser.mockRestore();
    });
    const all = await h.resolve("bob", references.toReversed());
    expect(all).toMatchObject({
      reference: references[31],
      trigger: "all",
      text: "Message 31 ||secret||",
    });
    const direct = await h.resolve("bob", references.toReversed(), {
      directOnly: true,
      includeText: true,
    });
    expect(direct).toMatchObject({
      reference: references[24],
      trigger: "direct",
      text: "Message 24 ||secret|| [](/mentions/bob)",
    });
    const generic = await h.resolve("bob", references, {
      directOnly: false,
      includeText: false,
    });
    expect(generic).toMatchObject({ reference: references[31], text: null });
    expect(parser).not.toHaveBeenCalled();
    for (const preview of ["generic", "who-and-where"] as const)
      notificationPayload(
        "bob",
        { paused: false, language: "en", preview },
        generic,
      );
    expect(parser).not.toHaveBeenCalled();
    expect(renderPreview(all!)).toBe("Message 31 •••");
    expect(parser).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + 32);
    const newestDirect = await h.send("Newest [](/mentions/bob) ||hidden||");
    parser.mockClear();
    const next = await h.resolve("bob", [...references.slice(1), newestDirect]);
    expect(next).toMatchObject({ reference: newestDirect, trigger: "direct" });
    expect(parser).not.toHaveBeenCalled();
    expect(renderPreview(next!)).toBe("Newest •••");
    expect(parser).toHaveBeenCalledTimes(1);

    await h.owner.updateRead(principal("bob"), {
      channelId: h.channelId,
      sequence: newestDirect.sequence,
    });
    parser.mockClear();
    expect(
      await h.resolve("bob", [...references.slice(1), newestDirect]),
    ).toBeNull();
    expect(parser).not.toHaveBeenCalled();
  });

  it("keeps the original input-order choice when creation timestamps tie", async ({
    onTestFinished,
  }) => {
    const h = await setup();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    onTestFinished(() => {
      clock.mockRestore();
    });
    const direct = await h.send("Direct [](/mentions/bob)");
    const ordinary = await h.send("Ordinary");
    expect(direct.createdAt).toBe(ordinary.createdAt);
    expect(await h.resolve("bob", [direct, ordinary])).toMatchObject({
      reference: direct,
    });
    expect(await h.resolve("bob", [ordinary, direct])).toMatchObject({
      reference: ordinary,
    });
    expect(
      await h.resolve("bob", [ordinary, direct], {
        directOnly: true,
        includeText: true,
      }),
    ).toMatchObject({ reference: direct });
  });

  it("checks each message against private read position without preserving a read mention for unrelated unread", async () => {
    const h = await setup();
    const mention = await h.send("Hello [](/mentions/bob)");
    const ordinary = await h.send("Unrelated unread");
    const initial = await h.resolve("bob", [mention, ordinary], {
      directOnly: true,
      includeText: true,
    });
    expect(await h.resolve("bob", [mention, ordinary])).toMatchObject({
      reference: ordinary,
    });
    expect(initial?.trigger).toBe("direct");
    await h.owner.updateRead(principal("bob"), {
      channelId: h.channelId,
      sequence: mention.sequence,
    });
    expect(
      await h.resolve("bob", [mention, ordinary], {
        directOnly: true,
        includeText: true,
      }),
    ).toBeNull();
    expect(await h.resolve("bob", [mention, ordinary])).toMatchObject({
      reference: ordinary,
      trigger: "all",
    });
    expect(await h.resolve("alice", [ordinary])).toBeNull();
    expect(await h.resolve("outsider", [ordinary])).toBeNull();
    expect(
      await h.resolve("bob", [
        { ...ordinary, ownerGeneration: crypto.randomUUID() },
      ]),
    ).toBeNull();
    expect(
      await h.resolve("bob", [{ ...ordinary, sequence: mention.sequence }]),
    ).toBeNull();
    expect(await h.resolve("bob", Array(33).fill(ordinary))).toBeNull();
  });

  it("uses current valid mentions after edits while mass mentions and reactions do not qualify", async () => {
    const h = await setup();
    const original = await h.send("Hi [](/mentions/bob)");
    const ordinary = await h.send("@everyone @here [](/mentions/outsider)");
    expect(
      await h.resolve("bob", [original, ordinary], {
        directOnly: true,
        includeText: true,
      }),
    ).toMatchObject({ reference: original, trigger: "direct" });
    receipt(
      await h.owner.edit(principal("alice"), {
        ...command(h.channelId),
        messageId: original.messageId,
        expectedVersion: 1,
        body: "Edited away",
      }),
    );
    receipt(
      await h.owner.edit(principal("alice"), {
        ...command(h.channelId),
        messageId: ordinary.messageId,
        expectedVersion: 1,
        body: "Added [](/mentions/bob)",
      }),
    );
    expect(await h.resolve("bob", [original, ordinary])).toMatchObject({
      reference: ordinary,
      trigger: "direct",
      text: "Added [](/mentions/bob)",
    });
    receipt(
      await h.owner.react(principal("bob"), {
        ...command(h.channelId),
        messageId: original.messageId,
        emoji: "👍",
        on: true,
      }),
    );
    expect(await h.resolve("bob", [original])).toMatchObject({
      trigger: "all",
    });
    receipt(
      await h.owner.deleteMessage(principal("alice"), {
        ...command(h.channelId),
        messageId: original.messageId,
        expectedVersion: 2,
      }),
    );
    expect(await h.resolve("bob", [original])).toBeNull();
  });

  it("renders authorized owner text in the recipient without spoilers, links or raw mention identities", async () => {
    const h = await setup();
    const message = await h.send(
      "**Hello** [](/mentions/bob), ||secret ending [hidden label](https://hidden.invalid/token)|| [visible label](https://private.invalid/token) `literal ||code||`",
    );
    const selected = (await h.resolve("bob", [message]))!;
    expect(selected.text).toContain("secret ending");
    const preview = renderPreview(selected);
    expect(preview).toBe("Hello , ••• visible label literal ||code||");
    expect(preview).not.toMatch(/secret|hidden|private|mentions|bob/);
    const source = await h.send(
      "Quote ||concealed quote|| [label](https://quote.invalid/token)",
      "bob",
    );
    const quote = await h.send("", "alice", {
      owner: source.owner,
      channelId: h.channelId,
      messageId: source.messageId,
    });
    const quoted = (await h.resolve("bob", [quote]))!;
    expect(quoted.trigger).toBe("direct");
    expect(renderPreview(quoted)).toBe("Quote ••• label");
    expect(
      await h.resolve("bob", [quote], {
        directOnly: true,
        includeText: false,
      }),
    ).toMatchObject({ reference: quote, trigger: "direct", text: null });
    const long = await h.send("😀".repeat(300));
    const bounded = renderPreview((await h.resolve("bob", [long]))!);
    expect(Array.from(bounded)).toHaveLength(240);
    expect(bounded).toBe("😀".repeat(240));
  });

  it("requires current destination access for quote recipients regardless of access when sent", async () => {
    const h = await setup();
    const quoted = await h.send("Come join", "bob");
    const quote = {
      owner: quoted.owner,
      channelId: h.channelId,
      messageId: quoted.messageId,
    };
    const reply = await h.send("Reply", "alice", quote);
    expect(await h.resolve("bob", [reply])).toMatchObject({
      trigger: "direct",
    });
    await runInDurableObject(h.owner, async (_, state) => {
      state.storage.sql.exec(
        "UPDATE channels SET private=1 WHERE id=?",
        h.channelId,
      );
      state.storage.sql.exec(
        "INSERT INTO channel_members(channel_id,user_id) VALUES (?,'alice')",
        h.channelId,
      );
    });
    expect(await h.resolve("bob", [reply])).toBeNull();
    const hiddenReply = await h.send("Hidden reply", "alice", quote);
    await runInDurableObject(h.owner, async (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO channel_members(channel_id,user_id) VALUES (?,'bob')",
        h.channelId,
      );
    });
    expect(await h.resolve("bob", [hiddenReply])).toMatchObject({
      trigger: "direct",
    });
    expect(await h.resolve("bob", [reply])).toMatchObject({
      trigger: "direct",
    });
    await runInDurableObject(h.owner, async (_, state) => {
      state.storage.sql.exec("DELETE FROM members WHERE user_id='bob'");
    });
    expect(await h.resolve("bob", [reply])).toBeNull();
  });

  it("treats unread DMs as direct but suppresses after either participant blocks", async () => {
    const h = await setup("conversation");
    const sent = await h.send("Want to join?");
    expect(await h.resolve("bob", [sent])).toMatchObject({ trigger: "direct" });
    for (const blocker of ["alice", "bob"]) {
      await runInDurableObject(h.owner, async (_, state) => {
        state.storage.sql.exec("DELETE FROM direct_blocks");
        state.storage.sql.exec(
          "INSERT INTO direct_blocks(user_id,blocked,revision) VALUES (?,1,1)",
          blocker,
        );
      });
      expect(await h.resolve("bob", [sent])).toBeNull();
    }
  });
});

it("reuses room authority and private reads for mixed, repeated and stale notification references", async () => {
  const h = await setup();
  const read = await h.send("Already read");
  const ordinary = await h.send("Hello ||hidden|| [](/mentions/bob)");
  const removed = await h.send("Removed");
  const otherId = crypto.randomUUID();
  const hiddenId = crypto.randomUUID();
  for (const [channelId, expectedVersion] of [
    [otherId, 1],
    [hiddenId, 2],
  ] as const)
    expect(
      await env.SERVER_DO.getByName(h.id).createChannel(principal("alice"), {
        channelId,
        name: channelId === otherId ? "Other" : "Hidden",
        private: false,
        expectedVersion,
      }),
    ).toMatchObject({ kind: "changed" });
  async function inRoom(channelId: string) {
    const sent = receipt(
      (
        await h.owner.send(principal("alice"), {
          ...command(channelId),
          body: "Room unread",
        })
      ).outcome,
    );
    const original = await h.owner.originalMessage(principal("alice"), {
      channelId,
      messageId: sent.messageId,
    });
    if (original.kind !== "original_message") throw new Error(original.kind);
    return {
      ...ordinary,
      roomId: channelId,
      messageId: sent.messageId,
      sequence: sent.sequence,
      createdAt: original.message.createdAt,
    };
  }
  const other = await inRoom(otherId);
  const hidden = await inRoom(hiddenId);
  await h.owner.updateRead(principal("bob"), {
    channelId: h.channelId,
    sequence: read.sequence,
  });
  receipt(
    await h.owner.deleteMessage(principal("alice"), {
      ...command(h.channelId),
      messageId: removed.messageId,
      expectedVersion: 1,
    }),
  );
  await runInDurableObject(h.owner, (_, state) => {
    state.storage.sql.exec(
      "UPDATE channels SET private=1 WHERE id=?",
      hiddenId,
    );
  });
  const stale = [
    read,
    removed,
    hidden,
    { ...ordinary, ownerGeneration: crypto.randomUUID() },
    { ...ordinary, owner: { kind: "conversation" as const, id: h.id } },
    { ...ordinary, owner: { ...ordinary.owner, id: "another-owner" } },
    { ...ordinary, createdAt: ordinary.createdAt + 1 },
    { ...ordinary, sequence: ordinary.sequence + 1 },
    { ...ordinary, roomId: otherId },
    { ...ordinary, messageId: crypto.randomUUID() },
  ];
  const references = [
    ...stale,
    ...Array.from({ length: 22 }, (_, index) => (index % 2 ? other : ordinary)),
  ];
  const observed = await runInDurableObject(
    env.SERVER_DO.getByName(h.id),
    (instance, state) =>
      observeSql(state.storage.sql, () =>
        instance.selectNotificationMessage("bob", references, {
          directOnly: true,
          includeText: true,
        }),
      ),
  );
  expect(observed.value?.reference).toEqual(ordinary);
  expect(observed.value).toMatchObject({
    trigger: "direct",
    text: "Hello ||hidden|| [](/mentions/bob)",
    roomLabel: "general",
  });
  expect(await h.resolve("bob", references)).toMatchObject({
    reference: other,
    trigger: "all",
    text: "Room unread",
    roomLabel: "Other",
  });
  expect(selectStatements(observed.statements)).toHaveLength(5);
  expect(
    observed.statements.every(({ bindings }) => bindings.length <= 100),
  ).toBe(true);
});
