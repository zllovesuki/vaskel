import { acceptedMessage } from "@tests/helpers/messaging";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { COMMAND_RETRY_MS } from "@vaskel/contracts/messaging";
import { storageObservation } from "@/server/actors/shared/attachments/types";
import {
  blockCommand,
  blockingPair,
  blockResult,
  pairPrincipal,
} from "@tests/helpers/blocking-harness";

describe("canonical pair block authority on workerd", () => {
  it.each(["send-first", "block-first"] as const)(
    "commits the %s order without losing history or accepting a new send",
    async (order) => {
      const h = await blockingPair();
      const original = h.send();
      const first =
        order === "send-first"
          ? acceptedMessage((await h.owner.send(h.alice, original)).outcome)
          : null;
      blockResult(
        await h.owner.setBlock(h.bob, h.alice.userId, blockCommand()),
      );
      for (const principal of [h.alice, h.bob])
        expect(
          (await h.owner.send(principal, h.send("New send"))).outcome,
        ).toEqual({
          kind: "dm_blocked",
        });
      if (first) {
        expect((await h.owner.send(h.alice, original)).outcome).toEqual({
          kind: "accepted",
          receipt: first,
        });
        expect(
          await h.owner.search(h.bob, { channelId: h.id, query: "東京都" }),
        ).toMatchObject({
          kind: "matches",
          messages: [{ id: first.messageId }],
        });
        expect(
          await h.owner.updateRead(h.bob, {
            channelId: h.id,
            sequence: first.sequence,
          }),
        ).toEqual({ kind: "read_updated", sequence: 1 });
        expect(
          await h.owner.snapshot(h.alice, { channelId: h.id }),
        ).toMatchObject({ kind: "snapshot", readSequence: 0 });
        const edited = acceptedMessage(
          await h.owner.edit(h.alice, {
            ...h.send("東京都 edited"),
            messageId: first.messageId,
            expectedVersion: 1,
          }),
        );
        acceptedMessage(
          await h.owner.deleteMessage(h.alice, {
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
            channelId: h.id,
            messageId: first.messageId,
            expectedVersion: edited.version,
          }),
        );
        expect(
          await h.owner.snapshot(h.bob, { channelId: h.id }),
        ).toMatchObject({
          kind: "snapshot",
          messages: [
            { id: first.messageId, body: null, deletedAt: expect.any(Number) },
          ],
        });
      } else
        expect(
          await h.owner.snapshot(h.alice, { channelId: h.id }),
        ).toMatchObject({
          kind: "snapshot",
          messages: [],
          cursor: { sequence: 0 },
        });
    },
  );

  it("keeps directed revisions independent and returns immutable retry receipts with current status", async () => {
    const h = await blockingPair();
    const command = blockCommand();
    const first = blockResult(
      await h.owner.setBlock(h.alice, h.bob.userId, command),
    );
    expect(first.status).toEqual({
      targetId: h.bob.userId,
      conversationId: h.id,
      blocked: true,
      revision: 1,
      canSend: false,
    });
    const opposite = blockResult(
      await h.owner.setBlock(h.bob, h.alice.userId, blockCommand()),
    );
    expect(opposite.status.revision).toBe(1);
    expect(
      await h.owner.setBlock(h.alice, h.bob.userId, blockCommand(false)),
    ).toEqual({ kind: "stale_revision", currentRevision: 1 });
    expect(
      await h.owner.setBlock(h.alice, h.bob.userId, {
        ...command,
        blocked: false,
      }),
    ).toEqual({ kind: "command_conflict" });
    const unblock = blockCommand(false, 1);
    const retries = await Promise.all(
      Array.from({ length: 4 }, () =>
        h.owner.setBlock(h.alice, h.bob.userId, unblock),
      ),
    );
    for (const result of retries)
      expect(blockResult(result).status).toMatchObject({
        blocked: false,
        revision: 2,
        canSend: false,
      });
    const bothUnblocked = blockResult(
      await h.owner.setBlock(h.bob, h.alice.userId, blockCommand(false, 1)),
    );
    expect(bothUnblocked.status.canSend).toBe(true);
    await evictDurableObject(h.owner);
    expect(
      blockResult(await h.owner.setBlock(h.alice, h.bob.userId, command)),
    ).toEqual({
      kind: "block_updated",
      receipt: first.receipt,
      status: { ...first.status, blocked: false, revision: 2, canSend: true },
    });
    expect(
      blockResult(await h.owner.setBlock(h.alice, h.bob.userId, unblock)).status
        .revision,
    ).toBe(2);
    expect(
      await h.owner.setBlock(h.alice, h.bob.userId, {
        ...blockCommand(),
        issuedAt: Date.now() - COMMAND_RETRY_MS - 1_000,
      }),
    ).toEqual({ kind: "command_expired" });
    expect(
      await h.owner.setBlock(
        { ...h.alice, expiresAt: 0 },
        h.bob.userId,
        blockCommand(),
      ),
    ).toEqual({ kind: "unauthenticated" });
    acceptedMessage((await h.owner.send(h.alice, h.send())).outcome);
  });

  it("initializes a private pair before any DM and preserves it during later conversation initialization", async () => {
    const h = await blockingPair(false);
    blockResult(await h.owner.setBlock(h.alice, h.bob.userId, blockCommand()));
    await runInDurableObject(h.owner, (_instance, state) => {
      for (const table of [
        "owner_state",
        "members",
        "channels",
        "events",
        "messages",
      ])
        expect(
          state.storage.sql
            .exec(`SELECT COUNT(*) AS count FROM ${table}`)
            .one(),
        ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM direct_pair")
          .one(),
      ).toEqual({ count: 1 });
    });
    expect(await h.owner.snapshot(h.alice, { channelId: h.id })).toEqual({
      kind: "not_found",
    });
    expect(
      await h.owner.setBlock(pairPrincipal(), h.bob.userId, blockCommand()),
    ).toEqual({ kind: "command_conflict" });
    expect(
      await h.owner.initialize({
        conversationId: h.id,
        participantIds: [h.alice.userId, h.bob.userId, crypto.randomUUID()],
      }),
    ).toEqual({ kind: "command_conflict" });
    expect(
      await h.owner.initialize({
        conversationId: h.id,
        participantIds: [h.bob.userId, h.alice.userId],
      }),
    ).toMatchObject({ kind: "initialized" });
    expect(await h.owner.directStatus(h.bob)).toEqual({
      kind: "block_status",
      status: {
        targetId: h.alice.userId,
        conversationId: h.id,
        blocked: false,
        revision: 0,
        canSend: false,
      },
    });
    expect((await h.owner.send(h.bob, h.send())).outcome).toEqual({
      kind: "dm_blocked",
    });
    const serverId = crypto.randomUUID();
    const server = env.SERVER_DO.getByName(serverId);
    await server.initialize({
      serverId,
      name: "Unrelated permission",
      ownerId: h.alice.userId,
    });
    acceptedMessage(
      (await server.send(h.alice, { ...h.send(), channelId: serverId }))
        .outcome,
    );
    expect(
      (await server.send(h.bob, { ...h.send(), channelId: serverId })).outcome,
    ).toEqual({ kind: "forbidden" });
    // Existing multi-participant storage is not a pair policy or a cross-owner fanout.
    const group = await blockingPair(false);
    await group.owner.initialize({
      conversationId: group.id,
      participantIds: [
        group.alice.userId,
        group.bob.userId,
        crypto.randomUUID(),
      ],
    });
    expect(
      await group.owner.setBlock(group.alice, group.bob.userId, blockCommand()),
    ).toEqual({ kind: "command_conflict" });
    acceptedMessage(
      (await group.owner.send(group.alice, group.send())).outcome,
    );
  });

  it("rolls back pair creation and rule revision when the receipt commit fails", async () => {
    const h = await blockingPair(false);
    const command = blockCommand();
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER rejected_block AFTER INSERT ON block_receipts BEGIN SELECT RAISE(ABORT, 'injected block receipt failure'); END",
      );
    });
    await expect(
      (async () => h.owner.setBlock(h.alice, h.bob.userId, command))(),
    ).rejects.toThrow(/injected block receipt failure/);
    await runInDurableObject(h.owner, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER rejected_block");
      for (const table of ["direct_pair", "direct_blocks", "block_receipts"])
        expect(
          state.storage.sql
            .exec(`SELECT COUNT(*) AS count FROM ${table}`)
            .one(),
        ).toEqual({ count: 0 });
    });
    expect(
      blockResult(await h.owner.setBlock(h.alice, h.bob.userId, command)).status
        .revision,
    ).toBe(1);
  });

  it("retains receipts, blocking, reads, search and file liability across actor eviction", async () => {
    const h = await blockingPair();
    const command = h.send();
    const receipt = acceptedMessage(
      (await h.owner.send(h.alice, command)).outcome,
    );
    const file = await h.reserve();
    await h.owner.updateRead(h.bob, {
      channelId: h.id,
      sequence: receipt.sequence,
    });
    const block = blockCommand();
    const acceptedBlock = blockResult(
      await h.owner.setBlock(h.bob, h.alice.userId, block),
    );
    await evictDurableObject(h.owner);
    expect(
      acceptedMessage((await h.owner.send(h.alice, command)).outcome),
    ).toEqual(receipt);
    expect(
      blockResult(await h.owner.setBlock(h.bob, h.alice.userId, block)).status,
    ).toEqual(acceptedBlock.status);
    expect(
      acceptedMessage((await h.owner.send(h.alice, command)).outcome),
    ).toEqual(receipt);
    expect(await h.owner.snapshot(h.bob, { channelId: h.id })).toMatchObject({
      kind: "snapshot",
      readSequence: 1,
      messages: [{ id: receipt.messageId }],
    });
    expect(
      await h.owner.search(h.alice, { channelId: h.id, query: "東京都" }),
    ).toMatchObject({ kind: "matches", messages: [{ id: receipt.messageId }] });
    expect(await h.owner.beginAttachmentUpload(h.alice, file.fileId)).toEqual({
      kind: "dm_blocked",
    });
    await runInDurableObject(h.owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT high_water, attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ high_water: 1, attachment_bytes: 3 });
      expect(
        state.storage.sql
          .exec(
            "SELECT state, outstanding FROM attachments WHERE id = ?",
            file.fileId,
          )
          .one(),
      ).toEqual({ state: "reserved", outstanding: 1 });
    });
  });

  it("keeps claimed files readable and exact sends retryable, while denying every new attachment stage", async () => {
    const h = await blockingPair();
    const claimed = await h.reserve();
    const began = await h.owner.beginAttachmentUpload(h.alice, claimed.fileId);
    if (began.kind !== "attachment_upload") throw new Error(began.kind);
    const object = await env.ATTACHMENTS.put(
      began.upload.objectKey,
      new Uint8Array([1, 2, 3]),
      {
        customMetadata: {
          fileId: claimed.fileId,
          generation: began.upload.generation,
        },
      },
    );
    if (!object) throw new Error("Expected object");
    expect(
      await h.owner.completeAttachmentUpload(h.alice, began.upload, {
        kind: "stored",
        object: storageObservation(object),
      }),
    ).toMatchObject({ kind: "attachment_ready" });
    const command = h.send("", [claimed.fileId]);
    const receipt = acceptedMessage(
      (await h.owner.send(h.alice, command)).outcome,
    );
    const reserved = await h.reserve();
    const unclaimed = await h.reserve();
    const writing = await h.owner.beginAttachmentUpload(
      h.alice,
      unclaimed.fileId,
    );
    if (writing.kind !== "attachment_upload") throw new Error(writing.kind);
    const readyObject = await env.ATTACHMENTS.put(
      writing.upload.objectKey,
      new Uint8Array([4, 5, 6]),
      {
        customMetadata: {
          fileId: unclaimed.fileId,
          generation: writing.upload.generation,
        },
      },
    );
    if (!readyObject) throw new Error("Expected object");
    expect(
      await h.owner.completeAttachmentUpload(h.alice, writing.upload, {
        kind: "stored",
        object: storageObservation(readyObject),
      }),
    ).toMatchObject({ kind: "attachment_ready" });
    blockResult(await h.owner.setBlock(h.bob, h.alice.userId, blockCommand()));
    expect(await h.owner.reserveAttachment(h.alice, reserved.command)).toEqual({
      kind: "attachment_reserved",
      fileId: reserved.fileId,
      expiresAt: reserved.expiresAt,
    });
    expect(
      await h.owner.reserveAttachment(h.alice, h.reserveCommand()),
    ).toEqual({ kind: "dm_blocked" });
    expect(
      await h.owner.beginAttachmentUpload(h.alice, reserved.fileId),
    ).toEqual({ kind: "dm_blocked" });
    expect(
      (await h.owner.send(h.alice, h.send("", [unclaimed.fileId]))).outcome,
    ).toEqual({ kind: "dm_blocked" });
    expect(
      acceptedMessage((await h.owner.send(h.alice, command)).outcome),
    ).toEqual(receipt);
    expect(
      await h.owner.authorizeAttachmentDownload(h.bob, claimed.fileId),
    ).toMatchObject({
      kind: "attachment_download",
      download: { messageId: receipt.messageId },
    });
    expect(
      await h.owner.attachmentStatus(h.alice, claimed.fileId),
    ).toMatchObject({
      kind: "attachment_status",
      state: "claimed",
      messageId: receipt.messageId,
    });
    expect(
      await h.owner.completeAttachmentUpload(h.alice, writing.upload, {
        kind: "stored",
        object: storageObservation(readyObject),
      }),
    ).toEqual({ kind: "dm_blocked" });
    await runInDurableObject(h.owner, (_instance, state) => {
      const attachment = state.storage.sql
        .exec(
          "SELECT state, message_id FROM attachments WHERE id = ?",
          unclaimed.fileId,
        )
        .one();
      // Retirement is immediate; the owner alarm may also have cleaned the file.
      expect(["retired", "cleaned"]).toContain(attachment.state);
      expect(attachment.message_id).toBeNull();
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 1 });
    });
  });
});
