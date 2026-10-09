import { readHttpFailure } from "@tests/helpers/http";
import { describe, expect, it } from "vitest";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { OriginalMessageOutcomeSchema } from "@vaskel/contracts/messaging";
import {
  attachmentHarness,
  messagingResult,
} from "@tests/helpers/attachment-harness";
import {
  decodeApplicationResponse,
  messageCommand,
  resourcePath,
} from "@tests/helpers/application-harness";

describe("quoted Send, original lookup and removal through authenticated HTTP", () => {
  it("produces one quote shape for replies and forwards while separately authorizing older originals and files", async () => {
    const h = attachmentHarness();
    const { operator, first, second, alice, bob } = await h.twoServers();
    const sourcePath = resourcePath(first.owner);
    const targetPath = resourcePath(second.owner);
    expect(
      await decodeApplicationResponse(
        await operator.request(targetPath),
        DirectoryOutcomeSchema,
      ),
    ).toMatchObject({ kind: "directory", canSend: true });
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=",
      ),
      (value) => value.charCodeAt(0),
    );
    const file = await h.upload(
      alice.member,
      sourcePath,
      first.channelId,
      "image.png",
      bytes,
    );
    expect(file.attachment).toEqual({
      fileId: file.fileId,
      filename: "image.png",
      byteLength: bytes.byteLength,
    });
    const sent = await messagingResult(
      await alice.member.request(`${sourcePath}/send`, {
        ...messageCommand(first.channelId, "Source image"),
        attachmentIds: [file.fileId],
      }),
    );
    if (sent.kind !== "accepted") throw new Error(sent.kind);
    const invalidReaction = await alice.member.request(`${sourcePath}/react`, {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      channelId: first.channelId,
      messageId: sent.receipt.messageId,
      emoji: "not-a-supported-reaction",
      on: true,
    });
    expect(invalidReaction.status).toBe(400);
    expect(await readHttpFailure(invalidReaction)).toMatchObject({
      code: "BAD_REQUEST",
    });
    const quote = {
      owner: first.owner,
      channelId: first.channelId,
      messageId: sent.receipt.messageId,
    };
    const originalPath = `${sourcePath}/original-message`;
    const malformedOriginal = await operator.request(originalPath, {
      messageId: sent.receipt.messageId,
    });
    expect(malformedOriginal.status).toBe(400);
    expect(await readHttpFailure(malformedOriginal)).toMatchObject({
      code: "BAD_REQUEST",
    });
    const signedOutOriginal = await h.anonymous.request(originalPath, {
      channelId: first.channelId,
      messageId: sent.receipt.messageId,
    });
    expect(signedOutOriginal.status).toBe(401);
    expect(await readHttpFailure(signedOutOriginal)).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const reply = await messagingResult(
      await operator.request(`${sourcePath}/send`, {
        ...messageCommand(first.channelId, "Reply"),
        quote,
      }),
    );
    expect(reply.kind).toBe("accepted");
    const sourceSnapshot = await messagingResult(
      await operator.request(`${sourcePath}/snapshot`, {
        channelId: first.channelId,
      }),
    );
    if (sourceSnapshot.kind !== "snapshot")
      throw new Error(sourceSnapshot.kind);
    const replyQuote = sourceSnapshot.messages.at(-1)?.quote;
    expect(replyQuote).toMatchObject({
      source: quote,
      authorId: alice.registered.userId,
      body: "Source image",
      version: 1,
      attachmentCount: 1,
    });
    const command = { ...messageCommand(second.channelId, ""), quote };
    expect(
      await readHttpFailure(
        await operator.request(`${targetPath}/send`, {
          ...command,
          quote: { ...quote, body: "forged", authorId: "forged" },
        }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST" });
    const stream = await h.socket(bob.member, targetPath, second.channelId);
    try {
      const forwarded = await messagingResult(
        await operator.request(`${targetPath}/send`, command),
      );
      if (forwarded.kind !== "accepted") throw new Error(forwarded.kind);
      const frame = await stream.next();
      expect(frame).toMatchObject({
        type: "committed",
        event: {
          operation: "send",
          message: {
            id: forwarded.receipt.messageId,
            body: "",
            attachments: [],
            quote: replyQuote,
          },
        },
      });
      const page = await messagingResult(
        await operator.request(`${sourcePath}/snapshot`, {
          channelId: first.channelId,
          limit: 1,
        }),
      );
      if (page.kind !== "snapshot") throw new Error(page.kind);
      expect(
        page.messages.some((message) => message.id === sent.receipt.messageId),
      ).toBe(false);
      const original = await decodeApplicationResponse(
        await operator.request(`${sourcePath}/original-message`, {
          channelId: first.channelId,
          messageId: sent.receipt.messageId,
        }),
        OriginalMessageOutcomeSchema,
      );
      expect(original).toMatchObject({
        kind: "original_message",
        message: {
          id: sent.receipt.messageId,
          body: "Source image",
          attachments: [file.attachment],
        },
      });
      const denied = await bob.member.request(
        `${sourcePath}/original-message`,
        { channelId: first.channelId, messageId: sent.receipt.messageId },
      );
      expect(denied.status).toBe(409);
      expect(await readHttpFailure(denied)).toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      });
      expect((await bob.member.request(`${file.path}/grant`)).status).toBe(403);
      // Leading PNG bytes admit an inline type; the grant, not the byte route, checked access.
      const content = await h.download(operator, file.path);
      expect(content.headers.get("Content-Type")).toBe("image/png");
      expect(content.headers.get("Content-Disposition")).toMatch(/^inline;/);
      expect(content.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
      const { body: _body, ...removeFields } = messageCommand(first.channelId);
      const removal = {
        ...removeFields,
        messageId: sent.receipt.messageId,
        expectedVersion: 1,
        fileId: file.fileId,
      };
      const removed = await messagingResult(
        await alice.member.request(`${sourcePath}/remove-attachment`, removal),
      );
      expect(removed).toMatchObject({
        kind: "accepted",
        receipt: { version: 2 },
      });
      expect(
        await messagingResult(
          await alice.member.request(
            `${sourcePath}/remove-attachment`,
            removal,
          ),
        ),
      ).toEqual(removed);
      expect((await operator.request(`${file.path}/content`)).status).toBe(404);
      expect(
        await decodeApplicationResponse(
          await operator.request(`${sourcePath}/original-message`, {
            channelId: first.channelId,
            messageId: sent.receipt.messageId,
          }),
          OriginalMessageOutcomeSchema,
        ),
      ).toMatchObject({
        kind: "original_message",
        message: { body: "Source image", attachments: [], version: 2 },
      });
      const { fileId: _file, ...deleteFields } = removal;
      await messagingResult(
        await alice.member.request(`${sourcePath}/delete`, {
          ...deleteFields,
          commandId: crypto.randomUUID(),
          expectedVersion: 2,
        }),
      );
      expect(
        await messagingResult(
          await operator.request(`${targetPath}/send`, command),
        ),
      ).toEqual(forwarded);
      expect(
        (
          await operator.request(`${sourcePath}/original-message`, {
            channelId: first.channelId,
            messageId: sent.receipt.messageId,
          })
        ).status,
      ).toBe(409);
      expect(
        await messagingResult(
          await bob.member.request(`${targetPath}/snapshot`, {
            channelId: second.channelId,
          }),
        ),
      ).toMatchObject({
        kind: "snapshot",
        messages: [{ quote: replyQuote, attachments: [] }],
      });
      await expect(
        messagingResult(
          await operator.request(`${targetPath}/send`, {
            ...command,
            commandId: crypto.randomUUID(),
          }),
          409,
        ),
      ).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
        data: { kind: "source_unavailable" },
      });
    } finally {
      await stream.close();
    }
  });
});
