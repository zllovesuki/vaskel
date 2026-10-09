import {
  messageEnvelope as envelope,
  acceptedMessage as accepted,
} from "@tests/helpers/messaging";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DELETED_PAYLOAD_RETENTION_MS,
  MessageBodySchema,
  MessagingOutcomeSchema,
  type QuoteReference,
  type SendMessage,
} from "@vaskel/contracts/messaging";
import { uploadAttachment } from "@/server/files/upload";
import { sendMessage } from "@/server/routes/message-send";
import { drainAttachments } from "@/server/actors/shared/attachments/cleanup";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { messageSearchBody } from "@/server/actors/shared/message-search";
import { ownerAlarm } from "@/server/actors/shared/maintenance";
import { storageObservation } from "@/server/actors/shared/attachments/types";
import type { Principal } from "@/server/domain/principal";

const principal = (userId = "alice"): Principal => ({
  userId,
  sessionId: `session-${userId}`,
  expiresAt: Date.now() + 60_000,
});

async function setup() {
  const sourceId = crypto.randomUUID();
  const source = env.CONVERSATION_DO.getByName(sourceId);
  await source.initialize({
    conversationId: sourceId,
    participantIds: ["alice", "bob"],
  });
  const targetId = crypto.randomUUID();
  const target = env.SERVER_DO.getByName(targetId);
  await target.initialize({
    serverId: targetId,
    name: "Destination",
    ownerId: "alice",
  });
  async function upload(
    bytes: Uint8Array = new Uint8Array([1, 2, 3]),
    filename = "source.txt",
  ) {
    const reserved = await source.reserveAttachment(principal("bob"), {
      ...envelope(sourceId),
      filename,
      byteLength: bytes.byteLength,
    });
    if (reserved.kind !== "attachment_reserved") throw new Error(reserved.kind);
    const result = await uploadAttachment(
      new Request("https://vaskel.test/upload", { method: "PUT", body: bytes }),
      env.ATTACHMENTS,
      source,
      principal("bob"),
      reserved.fileId,
      async () => principal("bob"),
      () => undefined,
    );
    if (result.kind !== "attachment_ready") throw new Error(result.kind);
    return { ...reserved, attachment: result.attachment, bytes };
  }
  const sent = async (body: string, fileIds: string[] = []) =>
    accepted(
      (
        await source.send(principal("bob"), {
          ...envelope(sourceId),
          body,
          attachmentIds: fileIds,
        })
      ).outcome,
    );
  const reference = (messageId: string): QuoteReference => ({
    owner: { kind: "conversation", id: sourceId },
    channelId: sourceId,
    messageId,
  });
  const command = (messageId: string, body = ""): SendMessage => ({
    ...envelope(targetId),
    body,
    quote: reference(messageId),
  });
  const send = async (
    command: SendMessage,
    overrides: Partial<Parameters<typeof sendMessage>[0]> = {},
  ) => {
    const execution = createExecutionContext();
    const result = await sendMessage({
      env,
      waitUntil: (work) => execution.waitUntil(work),
      target: { owner: { kind: "server", id: targetId }, stub: target },
      principal: principal(),
      command,
      source: async () => source,
      refreshPrincipal: async () => principal(),
      ...overrides,
    });
    await waitOnExecutionContext(execution);
    return result;
  };
  return {
    sourceId,
    source,
    targetId,
    target,
    upload,
    sent,
    reference,
    command,
    send,
  };
}

describe("captured text quotes and individual attachment removal on native owners", () => {
  it("captures one same-owner snapshot, preserves meaning after source changes and indexes destination quote text", async () => {
    const h = await setup();
    const body = "東京都の原文" + "𠮷".repeat(300);
    const original = await h.sent(body);
    const command = {
      ...envelope(h.sourceId),
      body: "Separate commentary",
      quote: h.reference(original.messageId),
    };
    const quote = accepted((await h.source.send(principal(), command)).outcome);
    await h.source.edit(principal("bob"), {
      ...envelope(h.sourceId),
      messageId: original.messageId,
      expectedVersion: 1,
      body: "Changed original",
    });
    await h.source.deleteMessage(principal("bob"), {
      ...envelope(h.sourceId),
      messageId: original.messageId,
      expectedVersion: 2,
    });
    const snapshot = MessagingOutcomeSchema.parse(
      await h.source.snapshot(principal(), { channelId: h.sourceId }),
    );
    if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
    expect(
      snapshot.messages.find((message) => message.id === quote.messageId),
    ).toMatchObject({
      body: "Separate commentary",
      quote: {
        source: command.quote,
        authorId: "bob",
        body,
        version: 1,
        attachmentCount: 0,
      },
      attachments: [],
    });
    expect(
      accepted((await h.source.send(principal(), command)).outcome),
    ).toEqual(quote);
    expect(
      (
        await h.source.send(principal(), {
          ...command,
          commandId: crypto.randomUUID(),
        })
      ).outcome,
    ).toEqual({ kind: "source_unavailable" });
    expect(
      await h.source.originalMessage(principal(), {
        channelId: h.sourceId,
        messageId: original.messageId,
      }),
    ).toEqual({ kind: "source_unavailable" });
    const matches = await h.source.search(principal(), {
      channelId: h.sourceId,
      query: "東京都",
    });
    if (matches.kind !== "matches") throw new Error(matches.kind);
    expect(matches.messages.map((message) => message.id)).toEqual([
      quote.messageId,
    ]);
    await h.source.edit(principal(), {
      ...envelope(h.sourceId),
      messageId: quote.messageId,
      expectedVersion: 1,
      body: "",
    });
    const after = await h.source.search(principal(), {
      channelId: h.sourceId,
      query: "東京都",
    });
    expect(after).toMatchObject({
      kind: "matches",
      messages: [{ id: quote.messageId, body: "", quote: { body } }],
    });
  });

  it("checks private source channels inside same-owner sends and rolls the whole quote mutation back", async () => {
    const h = await setup();
    const channelId = crypto.randomUUID();
    await h.target.createChannel(principal(), {
      channelId,
      name: "Private",
      private: true,
      expectedVersion: 1,
    });
    const original = accepted(
      (
        await h.target.send(principal(), {
          ...envelope(channelId),
          body: "Private source",
        })
      ).outcome,
    );
    const quote: QuoteReference = {
      owner: { kind: "server", id: h.targetId },
      channelId,
      messageId: original.messageId,
    };
    const command = { ...envelope(h.targetId), body: "", quote };
    expect(
      await h.target.setChannelMember(principal(), {
        channelId,
        userId: "alice",
        allowed: false,
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "changed", version: 2 });
    expect((await h.target.send(principal(), command)).outcome).toEqual({
      kind: "source_unavailable",
    });
    expect(
      await h.target.setChannelMember(principal(), {
        channelId,
        userId: "alice",
        allowed: true,
        expectedVersion: 2,
      }),
    ).toMatchObject({ kind: "changed", version: 3 });
    await runInDurableObject(h.target, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_quote AFTER INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'quote receipt failure'); END",
      );
    });
    await expect(
      (async () => (await h.target.send(principal(), command)).outcome)(),
    ).rejects.toThrow("quote receipt failure");
    await runInDurableObject(h.target, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM messages WHERE quote_json IS NOT NULL",
          )
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS count FROM events").one(),
      ).toEqual({ count: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM command_receipts")
          .one(),
      ).toEqual({ count: 1 });
      state.storage.sql.exec("DROP TRIGGER fail_quote");
    });
    const receipt = accepted(
      (await h.target.send(principal(), command)).outcome,
    );
    expect(receipt.sequence).toBe(2);
  });

  it("captures cross-owner text without copying private files and recovers one receipt across source revisions and deletion", async () => {
    const h = await setup();
    const file = await h.upload();
    const original = await h.sent("Captured version one", [file.fileId]);
    // A text quote must succeed independently of the original file's object availability.
    await env.ATTACHMENTS.delete(
      `attachments/conversation/${h.sourceId}/${file.fileId}`,
    );
    const command = h.command(original.messageId);
    const capture = await h.source.captureQuote(principal(), command.quote!);
    if (capture.kind !== "quote_captured") throw new Error(capture.kind);
    await h.source.edit(principal("bob"), {
      ...envelope(h.sourceId),
      messageId: original.messageId,
      expectedVersion: 1,
      body: "Captured version two",
    });
    const later = await h.source.captureQuote(principal(), command.quote!);
    if (later.kind !== "quote_captured") throw new Error(later.kind);
    const duplicates = await Promise.all([
      h.target
        .send(principal(), command, capture.capture)
        .then(({ outcome }) => outcome),
      h.target
        .send(principal(), command, later.capture)
        .then(({ outcome }) => outcome),
    ]);
    const receipt = accepted(duplicates[0]!);
    expect(accepted(duplicates[1]!)).toEqual(receipt);
    await h.source.deleteMessage(principal("bob"), {
      ...envelope(h.sourceId),
      messageId: original.messageId,
      expectedVersion: 2,
    });
    const forbiddenSource = async () => {
      throw new Error("Receipt consulted source");
    };
    expect(
      accepted(await h.send({ ...command }, { source: forbiddenSource })),
    ).toEqual(receipt);
    await runInDurableObject(h.target, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS count FROM messages").one(),
      ).toEqual({ count: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM attachments")
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec("SELECT attachment_bytes FROM owner_state")
          .one(),
      ).toEqual({ attachment_bytes: 0 });
    });
    const snapshot = await h.target.snapshot(principal(), {
      channelId: h.targetId,
    });
    if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
    expect(snapshot.messages[0]).toMatchObject({
      body: "",
      attachments: [],
      quote: { authorId: "bob", attachmentCount: 1 },
    });
    expect(["Captured version one", "Captured version two"]).toContain(
      snapshot.messages[0]?.quote?.body,
    );
    expect(JSON.stringify(snapshot.messages[0]?.quote)).not.toContain(
      file.fileId,
    );
    expect(
      await h.send({ ...command, commandId: crypto.randomUUID() }),
    ).toEqual({ kind: "source_unavailable" });
  });

  it("uses capture as the sharing point, rejects delayed account replacement and matches the trusted selected reference", async () => {
    const h = await setup();
    const original = await h.sent("Authorized capture");
    const command = h.command(original.messageId);
    expect(
      await h.send(command, { refreshPrincipal: async () => principal("bob") }),
    ).toEqual({ kind: "unauthenticated" });
    const capture = await h.source.captureQuote(principal(), command.quote!);
    if (capture.kind !== "quote_captured") throw new Error(capture.kind);
    expect(
      (
        await h.target.send(principal(), command, {
          ...capture.capture,
          selected: {
            ...capture.capture.selected,
            messageId: crypto.randomUUID(),
          },
        })
      ).outcome,
    ).toEqual({ kind: "invalid_input" });
    const receipt = accepted(
      await h.send(command, {
        refreshPrincipal: async () => {
          await h.source.deleteMessage(principal("bob"), {
            ...envelope(h.sourceId),
            messageId: original.messageId,
            expectedVersion: 1,
          });
          return principal();
        },
      }),
    );
    expect(receipt.version).toBe(1);
    const snapshot = await h.target.snapshot(principal(), {
      channelId: h.targetId,
    });
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      messages: [{ quote: { body: "Authorized capture" } }],
    });
  });

  it("flattens pure quotes without re-reading their deleted original and preserves captions and own-file placeholders", async () => {
    const h = await setup();
    const original = await h.sent("Original attribution");
    const first = accepted(await h.send(h.command(original.messageId)));
    await h.source.deleteMessage(principal("bob"), {
      ...envelope(h.sourceId),
      messageId: original.messageId,
      expectedVersion: 1,
    });
    const firstRef: QuoteReference = {
      owner: { kind: "server", id: h.targetId },
      channelId: h.targetId,
      messageId: first.messageId,
    };
    const flattened = accepted(
      (
        await h.target.send(principal(), {
          ...envelope(h.targetId),
          body: "",
          quote: firstRef,
        })
      ).outcome,
    );
    const captioned = accepted(
      (
        await h.target.send(principal(), {
          ...envelope(h.targetId),
          body: "My commentary",
          quote: firstRef,
        })
      ).outcome,
    );
    const captionQuote = accepted(
      (
        await h.target.send(principal(), {
          ...envelope(h.targetId),
          body: "",
          quote: { ...firstRef, messageId: captioned.messageId },
        })
      ).outcome,
    );
    const snapshot = await h.target.snapshot(principal(), {
      channelId: h.targetId,
    });
    if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
    expect(
      snapshot.messages.find((message) => message.id === flattened.messageId)
        ?.quote,
    ).toMatchObject({
      source: h.reference(original.messageId),
      body: "Original attribution",
      authorId: "bob",
    });
    expect(
      snapshot.messages.find((message) => message.id === captionQuote.messageId)
        ?.quote,
    ).toMatchObject({
      source: { ...firstRef, messageId: captioned.messageId },
      body: "My commentary",
      authorId: "alice",
    });
    const file = await h.upload();
    const source = await h.sent("Embedded text");
    const ownFile = accepted(
      (
        await h.source.send(principal("bob"), {
          ...envelope(h.sourceId),
          body: "",
          attachmentIds: [file.fileId],
          quote: h.reference(source.messageId),
        })
      ).outcome,
    );
    const fileQuote = await h.source.captureQuote(
      principal(),
      h.reference(ownFile.messageId),
    );
    expect(fileQuote).toMatchObject({
      kind: "quote_captured",
      capture: {
        snapshot: {
          source: h.reference(ownFile.messageId),
          authorId: "bob",
          body: "",
          attachmentCount: 1,
        },
      },
    });
    accepted(
      await h.source.removeMessageAttachment(principal("bob"), {
        ...envelope(h.sourceId),
        messageId: ownFile.messageId,
        expectedVersion: 1,
        fileId: file.fileId,
      }),
    );
    const retained = await h.source.originalMessage(principal(), {
      channelId: h.sourceId,
      messageId: ownFile.messageId,
    });
    expect(retained).toMatchObject({
      kind: "original_message",
      message: {
        body: "",
        attachments: [],
        quote: { body: "Embedded text" },
        deletedAt: null,
        version: 2,
      },
    });
  });

  it("atomically tombstones destination body and quote, removes them from FTS/replay, then collects both payloads", async () => {
    const h = await setup();
    const source = await h.sent("Retained quote contents");
    const sent = accepted(
      await h.send(h.command(source.messageId, "Own body contents")),
    );
    const before = await h.target.snapshot(principal(), {
      channelId: h.targetId,
    });
    if (before.kind !== "snapshot") throw new Error(before.kind);
    const command = {
      ...envelope(h.targetId),
      messageId: sent.messageId,
      expectedVersion: 1,
    };
    await runInDurableObject(h.target, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_quote_delete AFTER INSERT ON command_receipts WHEN NEW.operation = 'delete' BEGIN SELECT RAISE(ABORT, 'quote deletion failure'); END",
      );
    });
    await expect(
      (async () => await h.target.deleteMessage(principal(), command))(),
    ).rejects.toThrow("quote deletion failure");
    await runInDurableObject(h.target, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM deleted_payloads")
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM messages WHERE quote_json IS NOT NULL AND deleted_at IS NULL",
          )
          .one(),
      ).toEqual({ count: 1 });
      state.storage.sql.exec("DROP TRIGGER fail_quote_delete");
    });
    const deletedAt = Date.now();
    accepted(await h.target.deleteMessage(principal(), command));
    const replay = await h.target.replay(principal(), {
      channelId: h.targetId,
      cursor: before.cursor,
    });
    expect(replay).toMatchObject({
      kind: "replay",
      events: [
        { operation: "delete", message: { body: null, attachments: [] } },
      ],
    });
    expect(JSON.stringify(replay)).not.toContain("contents");
    expect(JSON.stringify(replay)).not.toContain('"quote"');
    expect(
      await h.target.search(principal(), {
        channelId: h.targetId,
        query: "contents",
      }),
    ).toMatchObject({ kind: "matches", messages: [] });
    await runInDurableObject(h.target, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ body: string; quote_json: string; eligible_at: number }>(
          "SELECT body, quote_json, eligible_at FROM deleted_payloads",
        )
        .one();
      expect(row.body).toBe("Own body contents");
      expect(JSON.parse(row.quote_json)).toMatchObject({
        body: "Retained quote contents",
      });
      expect(row.eligible_at).toBeGreaterThanOrEqual(
        deletedAt + DELETED_PAYLOAD_RETENTION_MS,
      );
      await ownerAlarm(state, openOwnerDatabase(state.storage));
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM deleted_payloads")
          .one(),
      ).toEqual({ count: 1 });
      state.storage.sql.exec(
        "UPDATE deleted_payloads SET eligible_at = ?",
        Date.now() - 1,
      );
      await ownerAlarm(state, openOwnerDatabase(state.storage));
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM deleted_payloads")
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql.exec("SELECT body, quote_json FROM messages").one(),
      ).toEqual({ body: null, quote_json: null });
    });
  });

  it("stores the legal maximum body plus quote as a bounded real native row and matching FTS document", async () => {
    const h = await setup();
    const body = "\0".repeat(3_999) + "a" + "\u0301".repeat(14_384);
    expect(new TextEncoder().encode(body).byteLength).toBe(32 * 1_024);
    expect(MessageBodySchema.safeParse(body).success).toBe(true);
    const source = await h.sent(body);
    const sent = accepted(await h.send(h.command(source.messageId, body)));
    await runInDurableObject(h.target, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ id: string; body: string; quote_json: string }>(
          "SELECT * FROM messages WHERE id = ?",
          sent.messageId,
        )
        .one();
      const serializedBytes = new TextEncoder().encode(
        JSON.stringify(row),
      ).byteLength;
      expect(serializedBytes).toBeGreaterThan(100_000);
      expect(serializedBytes).toBeLessThan(128 * 1_024);
      expect(messageSearchBody(row)).toBe(body + "\n" + body);
      expect(
        state.storage.sql
          .exec<{ message_id: string; body: null }>(
            "SELECT message_id, body FROM message_fts WHERE message_id = ?",
            sent.messageId,
          )
          .one(),
      ).toEqual({ message_id: sent.messageId, body: null });
    });
  });
  it("rolls back individual removal with its receipt and preserves the grace period, holds, and last-file tombstones", async () => {
    const h = await setup();
    const file = await h.upload();
    const other = await h.upload(new Uint8Array([4, 5, 6]), "second.txt");
    const message = await h.sent("Caption", [file.fileId, other.fileId]);
    const command = {
      ...envelope(h.sourceId),
      messageId: message.messageId,
      expectedVersion: 1,
      fileId: file.fileId,
    };
    await h.source.setAttachmentIncident(
      { ...principal(), isOperator: true },
      file.fileId,
      { quarantined: false, preserve: true, incidentReference: "test-hold" },
    );
    await runInDurableObject(h.source, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_remove AFTER INSERT ON command_receipts WHEN NEW.operation = 'remove_attachment' BEGIN SELECT RAISE(ABORT, 'remove receipt failure'); END",
      );
    });
    await expect(
      (async () =>
        await h.source.removeMessageAttachment(principal("bob"), command))(),
    ).rejects.toThrow("remove receipt failure");
    await runInDurableObject(h.source, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT state, message_id FROM attachments WHERE id = ?",
            file.fileId,
          )
          .one(),
      ).toEqual({ state: "claimed", message_id: message.messageId });
      expect(
        state.storage.sql
          .exec("SELECT version FROM messages WHERE id = ?", message.messageId)
          .one(),
      ).toEqual({ version: 1 });
      expect(
        state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
      ).toEqual({ high_water: 1 });
      state.storage.sql.exec("DROP TRIGGER fail_remove");
    });
    expect(
      await h.source.removeMessageAttachment(principal(), command),
    ).toEqual({ kind: "forbidden" });
    const removedAt = Date.now();
    const receipt = accepted(
      await h.source.removeMessageAttachment(principal("bob"), command),
    );
    expect(receipt.version).toBe(2);
    expect(
      accepted(
        await h.source.removeMessageAttachment(principal("bob"), {
          ...command,
        }),
      ),
    ).toEqual(receipt);
    expect(
      await h.source.removeMessageAttachment(principal("bob"), {
        ...command,
        commandId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "stale_version", currentVersion: 2 });
    await runInDurableObject(h.source, (_instance, state) => {
      const row = state.storage.sql
        .exec<{
          state: string;
          message_id: string | null;
          cleanup_at: number;
          preservation_hold: number;
        }>(
          "SELECT state, message_id, cleanup_at, preservation_hold FROM attachments WHERE id = ?",
          file.fileId,
        )
        .one();
      expect(row).toMatchObject({
        state: "retired",
        message_id: null,
        preservation_hold: 1,
      });
      expect(row.cleanup_at).toBeGreaterThanOrEqual(
        removedAt + DELETED_PAYLOAD_RETENTION_MS,
      );
    });
    expect(
      await h.source.authorizeAttachmentDownload(principal(), file.fileId),
    ).toEqual({ kind: "not_found" });
    await runDurableObjectAlarm(h.source);
    const key = `attachments/conversation/${h.sourceId}/${file.fileId}`;
    expect(await env.ATTACHMENTS.head(key)).not.toBeNull();
    await runInDurableObject(h.source, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachments SET cleanup_at = ? WHERE id = ?",
        Date.now() - 1,
        file.fileId,
      );
    });
    await runDurableObjectAlarm(h.source);
    expect(await env.ATTACHMENTS.head(key)).not.toBeNull();
    await h.source.setAttachmentIncident(
      { ...principal(), isOperator: true },
      file.fileId,
      {
        quarantined: false,
        preserve: false,
        incidentReference: "release-test-hold",
      },
    );
    await runInDurableObject(h.source, async (_instance, state) => {
      await drainAttachments(
        state,
        openOwnerDatabase(state.storage),
        env.ATTACHMENTS,
      );
    });
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    const remaining = await h.source.snapshot(principal(), {
      channelId: h.sourceId,
    });
    if (remaining.kind !== "snapshot") throw new Error(remaining.kind);
    expect(remaining.messages[0]).toMatchObject({
      body: "Caption",
      attachments: [{ fileId: other.fileId }],
    });
    await h.source.edit(principal("bob"), {
      ...envelope(h.sourceId),
      messageId: message.messageId,
      expectedVersion: 2,
      body: "",
    });
    accepted(
      await h.source.removeMessageAttachment(principal("bob"), {
        ...envelope(h.sourceId),
        messageId: message.messageId,
        expectedVersion: 3,
        fileId: other.fileId,
      }),
    );
    const deleted = MessagingOutcomeSchema.parse(
      await h.source.snapshot(principal(), { channelId: h.sourceId }),
    );
    if (deleted.kind !== "snapshot") throw new Error(deleted.kind);
    expect(deleted.messages[0]).toMatchObject({
      body: null,
      attachments: [],
      version: 4,
    });
    expect(deleted.messages[0]?.deletedAt).not.toBeNull();
    const retained = await env.ATTACHMENTS.head(
      `attachments/conversation/${h.sourceId}/${other.fileId}`,
    );
    if (!retained?.customMetadata?.generation)
      throw new Error("Missing retained object");
    expect(
      await h.source.completeAttachmentUpload(
        null,
        {
          fileId: other.fileId,
          objectKey: retained.key,
          generation: retained.customMetadata.generation,
          byteLength: retained.size,
          expiresAt: Date.now(),
        },
        { kind: "stored", object: storageObservation(retained) },
      ),
    ).toEqual({ kind: "attachment_expired" });
    await runInDurableObject(h.source, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ cleanup_at: number }>(
          "SELECT cleanup_at FROM attachments WHERE id = ?",
          other.fileId,
        )
        .one();
      expect(row.cleanup_at).toBeGreaterThanOrEqual(
        removedAt + DELETED_PAYLOAD_RETENTION_MS,
      );
    });
  });
});
